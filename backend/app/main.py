import io
import json
import logging
import os
import threading
import uuid
import zipfile
from contextlib import asynccontextmanager
from datetime import date, datetime
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, Field
from urllib.parse import quote
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    Request,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError
from .db import Base, engine, session, SessionLocal, STORAGE
from .models import (
    Event,
    Category,
    Expense,
    Receipt,
    Link,
    ImportJob,
    FinalVersion,
    Extraction,
    ChangeLog,
    ProcessingJob,
    AnnualBook,
    AnnualEntry,
    BudgetItem,
    now,
)
from .schemas import (
    EventIn,
    CategoryIn,
    ExpenseIn,
    BulkIn,
    ReceiptAnalysisIn,
    ReceiptSelectionIn,
    ReceiptIn,
    LinkIn,
    CommitIn,
    CopyIn,
    RevisionIn,
    FinalizeIn,
)
from .excel import parse_excel, export_excel
from .receipts import MAX_IMAGE, MAX_ZIP, unpack_images, recognize, parse_receipt
from .workflow import editable, audit, check, version_row, snapshot_excel, receipt_archive, FINAL
from .middleware import BodyLimitMiddleware
from .llm_service import extract_receipt, public_settings, Settings as LLMSettings

log = logging.getLogger(__name__)
JOBS = {}
JOB_LOCK = threading.Lock()
OCR_LOCK = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    # Alembic creates the schema before serving; never silently create unknown versions.
    from alembic.config import Config
    from alembic import command

    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    from .migration_backup import backup_before_upgrade

    backup_before_upgrade(config)
    command.upgrade(config, "head")
    JOBS.clear()
    with SessionLocal() as db:
        for j in db.scalars(select(ProcessingJob)):
            if j.status == "running":
                j.status = "interrupted"
                j.error_message = "서버 재시작으로 중단되었습니다. 다시 분석하세요."
            JOBS[j.id] = encode(j)
        db.commit()
    yield


def write_guard(request: Request, db: Session = Depends(session)):
    if request.method not in ["POST", "PUT", "PATCH", "DELETE"]:
        return
    path = request.path_params
    if request.url.path.endswith(("/reopen", "/duplicate")):
        return
    event_id = path.get("event_id")
    if path.get("book_id"):
        book = db.get(AnnualBook, int(path["book_id"]))
        if book:
            event_id = book.owner_event_id
    if path.get("entry_id"):
        entry = db.get(AnnualEntry, int(path["entry_id"]))
        if entry:
            event_id = db.get(AnnualBook, entry.book_id).owner_event_id
    if not event_id:
        for field, cls in [
            ("expense_id", Expense),
            ("receipt_id", Receipt),
            ("category_id", Category),
        ]:
            if field in path:
                obj = db.get(cls, int(path[field]))
                event_id = obj.event_id if obj else None
                break
    if event_id:
        current = db.get(Event, int(event_id))
        if (
            current
            and current.scope_type != "event"
            and (
                ("/expenses" in request.url.path or "/event-expenses" in request.url.path)
                or "/categories" in request.url.path
                or "/events/" in request.url.path
                and "/excel/import/" in request.url.path
            )
        ):
            raise HTTPException(422, "연도별 장부 거래·항목은 해당 메뉴의 전용 API에서 수정하세요.")
        # Explicit deletion removes the entire event, including its retained snapshots.
        if not (request.method == "DELETE" and request.url.path == f"/api/events/{event_id}"):
            editable(db, int(event_id))
        if any(
            j["event_id"] == int(event_id) and j["status"] == "running" for j in JOBS.values()
        ) and not request.url.path.endswith("/analyze"):
            raise HTTPException(409, "영수증 분석이 끝난 뒤 수정하세요.")


app = FastAPI(title="BPMC 행사 지출 관리", lifespan=lifespan, dependencies=[Depends(write_guard)])
app.add_middleware(BodyLimitMiddleware)


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    return JSONResponse(
        status_code=422,
        content={
            "detail": "입력값을 확인하세요.",
            "errors": [
                {"field": ".".join(map(str, e["loc"])), "message": e["msg"]} for e in exc.errors()
            ],
        },
    )


@app.exception_handler(StaleDataError)
async def stale_error(request, exc):
    return JSONResponse(
        status_code=409,
        content={"detail": "다른 작업에서 데이터가 변경되었습니다. 다시 열어 확인하세요."},
    )


@app.exception_handler(IntegrityError)
async def integrity_error(request, exc):
    return JSONResponse(
        status_code=409,
        content={"detail": "중복된 이름 또는 다른 데이터에서 참조 중인 항목입니다."},
    )


def get(db, cls, id):
    obj = db.get(cls, id)
    if not obj:
        raise HTTPException(404, "데이터를 찾을 수 없습니다.")
    return obj


def rows(db, cls, event_id):
    query = select(cls).where(cls.event_id == event_id)
    if cls is Expense:
        query = query.order_by(
            cls.expense_date.is_(None), cls.expense_date, cls.sort_order, cls.id
        )
    elif cls is Category:
        query = query.order_by(cls.sort_order, cls.id)
    elif cls is Receipt:
        query = query.order_by(
            Receipt.transaction_at.is_(None),
            Receipt.transaction_at,
            Receipt.original_name,
            Receipt.id,
        )
    return list(db.scalars(query))


def encode(obj):
    return {
        c.name: getattr(obj, c.name)
        for c in obj.__table__.columns
        if c.name not in ["stored_path", "payload"]
    }


def touch(db, event_id):
    e = get(db, Event, event_id)
    e.updated_at = now()
    e.version += 1


def detail(db, e):
    expenses = rows(db, Expense, e.id)
    cats = rows(db, Category, e.id)
    receipts = rows(db, Receipt, e.id)
    links = list(db.scalars(select(Link).join(Expense).where(Expense.event_id == e.id)))
    attached = {l.expense_id for l in links}
    return {
        **encode(e),
        "expense_count": len(expenses),
        "total_krw": sum(x.amount_krw or 0 for x in expenses),
        "matched_count": len(attached),
        "receipt_count": len(receipts),
        "expenses": [encode(x) for x in expenses],
        "categories": [encode(c) for c in cats],
        "receipts": [encode(r) for r in receipts],
        "links": [encode(l) for l in links],
        "category_totals": [
            {
                "id": c.id,
                "name": c.name,
                "color": c.color,
                "total": sum(x.amount_krw or 0 for x in expenses if x.category_id == c.id),
            }
            for c in cats
        ],
    }


def valid_category(db, event_id, category_id, existing=None):
    if category_id is None:
        return
    c = get(db, Category, category_id)
    if c.event_id != event_id:
        raise HTTPException(422, "다른 행사의 항목을 사용할 수 없습니다.")
    if not c.is_active and category_id != existing:
        raise HTTPException(422, "비활성 항목은 새로 지정할 수 없습니다.")


def apply_expense(db, e, data):
    values = data.model_dump(exclude={"id"})
    values["expense_date"] = data.expense_date.isoformat() if data.expense_date else None
    with db.no_autoflush:
        valid_category(db, e.event_id, data.category_id, getattr(e, "category_id", None))
    old = encode(e) if e.id else None
    for k, v in values.items():
        setattr(e, k, v)
    e.edited_by = "local-user"
    e.edited_at = now()
    audit(db, e.event_id, "expense", old, {**values, "edited_by": "local-user"}, e.id)


def list_detail(db, e):
    data = detail(db, e)
    if e.latest_final_version:
        snap = json.loads(version_row(db, e).snapshot_json)
        data["draft_total_krw"] = data["total_krw"]
        for key in ["total_krw", "expense_count", "matched_count", "receipt_count"]:
            data[key] = snap[key]
    return data


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "llm": public_settings(),
        "ocr_available": __import__("importlib.util", fromlist=["find_spec"]).find_spec("paddleocr")
        is not None,
    }


@app.get("/api/events")
def list_events(
    q: str = "",
    status: str = "",
    start_date: str = "",
    end_date: str = "",
    event_date_from: str = "",
    event_date_to: str = "",
    db: Session = Depends(session),
):
    events = list(
        db.scalars(
            select(Event)
            .where(Event.scope_type == "event")
            .order_by(Event.start_date.desc(), Event.id.desc())
        )
    )
    return [
        list_detail(db, e)
        for e in events
        if q.casefold() in e.name.casefold()
        and (not status or e.status == status)
        and (not start_date or e.end_date >= start_date)
        and (not end_date or e.start_date <= end_date)
        and (not event_date_from or (e.event_date or "") >= event_date_from)
        and (not event_date_to or (e.event_date or "") <= event_date_to)
    ]


@app.post("/api/events", status_code=201)
def create_event(data: EventIn, db: Session = Depends(session)):
    if data.status not in ["작성중", "검토중"]:
        raise HTTPException(422, "새 행사는 초안으로 생성해야 합니다.")
    values = data.model_dump()
    values["event_date"] = (data.event_date or data.end_date).isoformat()
    values.update(start_date=data.start_date.isoformat(), end_date=data.end_date.isoformat())
    e = Event(**values)
    db.add(e)
    db.flush()
    for i, (name, color) in enumerate(
        [
            ("음식/선물", "#dbeafe"),
            ("환대", "#fef3c7"),
            ("시각화", "#ede9fe"),
            ("준비비", "#e5e7eb"),
        ]
    ):
        db.add(Category(event_id=e.id, name=name, color=color, sort_order=i))
    db.commit()
    return detail(db, e)


@app.get("/api/events/{event_id}")
def event_detail(event_id: int, db: Session = Depends(session)):
    return detail(db, get(db, Event, event_id))


@app.patch("/api/events/{event_id}")
def update_event(event_id: int, data: EventIn, db: Session = Depends(session)):
    e = get(db, Event, event_id)
    if data.status not in ["작성중", "검토중", "재수정중"] or (
        e.latest_final_version and data.status != "재수정중"
    ):
        raise HTTPException(422, "확정 및 재수정 상태는 전용 동작으로 변경하세요.")
    for k, v in data.model_dump().items():
        setattr(e, k, v.isoformat() if isinstance(v, date) else v)
    touch(db, event_id)
    db.commit()
    return detail(db, e)


@app.delete("/api/events/{event_id}", status_code=204)
def delete_event(event_id: int, db: Session = Depends(session)):
    e = get(db, Event, event_id)
    paths = [STORAGE / r.stored_path for r in rows(db, Receipt, event_id)]
    for v in db.scalars(select(FinalVersion).where(FinalVersion.event_id == event_id)):
        paths.extend(STORAGE / r["stored_path"] for r in json.loads(v.snapshot_json)["receipts"])
    db.delete(e)
    db.commit()
    for p in paths:
        p.unlink(missing_ok=True)


@app.post("/api/events/{event_id}/duplicate", status_code=201)
def duplicate(event_id: int, db: Session = Depends(session)):
    old = get(db, Event, event_id)
    e = Event(name=old.name + " (복사)", start_date=old.start_date, end_date=old.end_date)
    db.add(e)
    db.flush()
    mapping = {}
    for c in rows(db, Category, event_id):
        new = Category(**{**encode(c), "id": None, "event_id": e.id})
        db.add(new)
        db.flush()
        mapping[c.id] = new.id
    for x in rows(db, Expense, event_id):
        db.add(
            Expense(
                **{**encode(x), "id": None, "event_id": e.id, "category_id": mapping[x.category_id]}
            )
        )
    db.commit()
    return detail(db, e)


@app.get("/api/events/{event_id}/categories")
def categories(event_id: int, db: Session = Depends(session)):
    get(db, Event, event_id)
    return [encode(c) for c in rows(db, Category, event_id)]


@app.post("/api/events/{event_id}/categories", status_code=201)
def add_category(event_id: int, data: CategoryIn, db: Session = Depends(session)):
    get(db, Event, event_id)
    c = Category(event_id=event_id, **data.model_dump())
    db.add(c)
    touch(db, event_id)
    db.commit()
    return encode(c)


@app.patch("/api/categories/{category_id}")
def update_category(category_id: int, data: CategoryIn, db: Session = Depends(session)):
    c = get(db, Category, category_id)
    for k, v in data.model_dump().items():
        setattr(c, k, v)
    touch(db, c.event_id)
    db.commit()
    return encode(c)


@app.delete("/api/categories/{category_id}", status_code=204)
def remove_category(category_id: int, move_to: int | None = None, db: Session = Depends(session)):
    c = get(db, Category, category_id)
    used = list(db.scalars(select(Expense).where(Expense.category_id == c.id)))
    if used:
        if not move_to or move_to == c.id:
            raise HTTPException(
                409, "사용 중인 항목입니다. 다른 항목으로 이동하거나 비활성화하세요."
            )
        valid_category(db, c.event_id, move_to)
        for x in used:
            x.category_id = move_to
    touch(db, c.event_id)
    db.delete(c)
    db.commit()


@app.post("/api/events/{event_id}/categories/copy")
def copy_categories(event_id: int, data: CopyIn, db: Session = Depends(session)):
    get(db, Event, event_id)
    get(db, Event, data.source_event_id)
    names = {c.name for c in rows(db, Category, event_id)}
    for c in rows(db, Category, data.source_event_id):
        if c.name not in names:
            db.add(Category(**{**encode(c), "id": None, "event_id": event_id}))
    touch(db, event_id)
    db.commit()
    return categories(event_id, db)


@app.get("/api/events/{event_id}/expenses")
def expenses(event_id: int, db: Session = Depends(session)):
    get(db, Event, event_id)
    return [encode(x) for x in rows(db, Expense, event_id)]


@app.post("/api/events/{event_id}/expenses", status_code=201)
def add_expense(event_id: int, data: ExpenseIn, db: Session = Depends(session)):
    get(db, Event, event_id)
    x = Expense(event_id=event_id)
    apply_expense(db, x, data)
    db.add(x)
    touch(db, event_id)
    db.commit()
    return encode(x)


@app.patch("/api/event-expenses/{expense_id}")
@app.patch("/api/expenses/{expense_id}")
def update_expense(expense_id: int, data: ExpenseIn, db: Session = Depends(session)):
    x = get(db, Expense, expense_id)
    apply_expense(db, x, data)
    touch(db, x.event_id)
    db.commit()
    return encode(x)


@app.delete("/api/event-expenses/{expense_id}", status_code=204)
@app.delete("/api/expenses/{expense_id}", status_code=204)
def remove_expense(expense_id: int, db: Session = Depends(session)):
    x = get(db, Expense, expense_id)
    touch(db, x.event_id)
    audit(db, x.event_id, "delete", encode(x), None, x.id)
    db.delete(x)
    db.commit()


@app.post("/api/events/{event_id}/draft/save")
@app.put("/api/events/{event_id}/expenses")
def save_expenses(event_id: int, data: BulkIn, db: Session = Depends(session)):
    e = get(db, Event, event_id)
    if e.version != data.version:
        raise HTTPException(409, "다른 작업에서 데이터가 변경되었습니다. 다시 열어 확인하세요.")
    existing = {x.id: x for x in rows(db, Expense, event_id)}
    keep = set()
    for i, r in enumerate(data.expenses):
        if r.id:
            if r.id not in existing or r.id in keep:
                raise HTTPException(422, "잘못되거나 중복된 지출 ID입니다.")
            keep.add(r.id)
            x = existing[r.id]
        else:
            x = Expense(event_id=event_id)
            db.add(x)
        apply_expense(db, x, r)
        x.sort_order = i
    for id, x in existing.items():
        if id not in keep:
            audit(db, event_id, "delete", encode(x), None, x.id)
            db.delete(x)
    touch(db, event_id)
    db.commit()
    return detail(db, e)


async def read_upload(file, limit):
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, "업로드 크기 제한을 초과했습니다.")
    return data


@app.get("/api/events/{event_id}/excel/import/template")
def event_excel_template(event_id: int, db: Session = Depends(session)):
    from .excel_templates import sample_workbook, MIME

    e = get(db, Event, event_id)
    data = sample_workbook(
        "event",
        int(e.start_date[:4]),
        categories=[c.name for c in rows(db, Category, event_id) if c.is_active],
    )
    return download(data, MIME, "행사비_지출내역_샘플.xlsx")


@app.post("/api/events/{event_id}/excel/import/preview")
async def excel_preview(
    event_id: int,
    file: UploadFile = File(...),
    mapping: str = Form("{}"),
    db: Session = Depends(session),
):
    e = get(db, Event, event_id)
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(422, ".xlsx 파일만 지원합니다.")
    data = await read_upload(file, 15 * 1024**2)
    try:
        result = parse_excel(data, int(e.start_date[:4]), json.loads(mapping))
    except Exception as exc:
        log.info("Excel import rejected: %s", exc)
        raise HTTPException(
            422, "Excel을 읽을 수 없습니다. 파일 형식·용량·암호화 여부를 확인하세요."
        ) from exc
    existing = {
        (x.expense_date, x.item_name, x.amount_krw, x.vendor) for x in rows(db, Expense, event_id)
    }
    for r in result["rows"]:
        if (r["expense_date"], r["item_name"], r["amount_krw"], r["vendor"]) in existing:
            result["warnings"].append(f"{r['source_row']}행: 기존 지출과 중복 후보입니다.")
    result["new_categories"] = sorted(
        {r["category_name"] for r in result["rows"]}
        - {c.name for c in rows(db, Category, event_id)}
    )
    result["version"] = e.version
    job = ImportJob(
        id=uuid.uuid4().hex,
        event_id=event_id,
        filename=(file.filename or "")[:200],
        payload=json.dumps(result, ensure_ascii=False),
    )
    db.add(job)
    db.commit()
    return {**result, "job_id": job.id}


@app.post("/api/events/{event_id}/excel/import/commit")
def excel_commit(event_id: int, data: CommitIn, db: Session = Depends(session)):
    e = get(db, Event, event_id)
    job = get(db, ImportJob, data.job_id)
    if job.event_id != event_id or job.status != "preview":
        raise HTTPException(409, "유효하지 않거나 이미 반영된 미리보기입니다.")
    result = json.loads(job.payload)
    if e.version != result["version"]:
        raise HTTPException(409, "미리보기 이후 데이터가 변경되었습니다. 다시 업로드하세요.")
    if result["errors"] or result["needs_mapping"] or not result["rows"]:
        raise HTTPException(422, "오류를 수정한 후 다시 업로드하세요.")
    if result["warnings"] and not data.accept_warnings:
        raise HTTPException(422, "날짜 및 중복 경고를 확인해주세요.")
    if data.mode == "replace" and not data.confirm_replace:
        raise HTTPException(422, "기존 데이터 대체 확인이 필요합니다.")
    cats = {c.name: c for c in rows(db, Category, event_id)}
    imported = 0
    prepared = []
    for r in result["rows"]:
        name = data.category_mapping.get(r["category_name"], r["category_name"])
        if name is None:
            continue
        name = name.strip()
        if not name or len(name) > 80:
            raise HTTPException(422, "항목명은 1~80자입니다.")
        if name not in cats:
            c = Category(event_id=event_id, name=name, sort_order=len(cats))
            db.add(c)
            db.flush()
            cats[name] = c
        if not cats[name].is_active:
            raise HTTPException(422, "비활성 항목에 가져올 수 없습니다.")
        values = {k: v for k, v in r.items() if k not in ["source_row", "category_name"]}
        valid = ExpenseIn(category_id=cats[name].id, **values)
        prepared.append(valid)
    if not prepared:
        raise HTTPException(422, "반영할 지출이 없습니다.")
    if data.mode == "replace":
        db.execute(delete(Expense).where(Expense.event_id == event_id))
    offset = len(rows(db, Expense, event_id))
    for i, r in enumerate(prepared):
        x = Expense(event_id=event_id)
        apply_expense(db, x, r)
        x.source_type = "excel"
        x.sort_order = offset + i
        db.add(x)
        imported += 1
    job.status = "committed"
    touch(db, event_id)
    db.commit()
    return {"imported_count": imported, "event": detail(db, e)}


def download(data, kind, name):
    return Response(
        content=data,
        media_type=kind,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"},
    )


@app.get("/api/events/{event_id}/excel/export")
def excel_download(
    event_id: int, version: int | None = None, draft: bool = False, db: Session = Depends(session)
):
    e = get(db, Event, event_id)
    if version or (e.latest_final_version and not draft):
        row = version_row(db, e, version)
        snap = json.loads(row.snapshot_json)
        return download(
            snapshot_excel(snap),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            f'{snap["name"]}_v{row.version_no}_지출내역.xlsx',
        )
    if not draft:
        raise HTTPException(422, "확정본이 없습니다. 초안 내보내기를 선택하세요.")
    links = list(db.scalars(select(Link).join(Expense).where(Expense.event_id == event_id)))
    data = export_excel(
        e,
        rows(db, Category, event_id),
        rows(db, Expense, event_id),
        rows(db, Receipt, event_id),
        links,
    )
    return download(
        data,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        f"DRAFT_{e.name}_지출내역.xlsx",
    )


@app.post("/api/events/{event_id}/receipts/upload")
async def receipt_upload(
    event_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(session),
    confirm_reuse: bool = Form(False),
):
    scope = get(db, Event, event_id)
    data = await read_upload(file, MAX_ZIP)
    try:
        if (file.filename or "").lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            if len(data) > MAX_IMAGE:
                raise ValueError(f"이미지 한 장은 {MAX_IMAGE // 1024**2}MB까지 지원합니다.")
            wrapped = io.BytesIO()
            with zipfile.ZipFile(wrapped, "w") as z:
                z.writestr(Path(file.filename).name, data)
            images = unpack_images(wrapped.getvalue())
        else:
            images = unpack_images(data)
    except Exception as exc:
        raise HTTPException(
            422, str(exc) if isinstance(exc, ValueError) else "유효한 이미지 ZIP을 업로드하세요."
        ) from exc
    existing = rows(db, Receipt, event_id)
    references = {}
    numbered = [(r.receipt_number or i, r) for i, r in enumerate(existing, 1)]
    for number, receipt in sorted(
        numbered, key=lambda item: (item[1].ocr_status == "제외", item[0])
    ):
        references.setdefault(receipt.sha256, f"영수증 #{number}")
    hashes = {im[3] for im in images} - references.keys()
    other = list(
        db.execute(
            select(Receipt, Event.name)
            .join(Event, Event.id == Receipt.event_id)
            .where(Receipt.sha256.in_(hashes), Receipt.event_id != event_id)
            .order_by(Receipt.ocr_status == "제외", Receipt.id)
        )
    )
    if other and not confirm_reuse:
        raise HTTPException(
            409, "다른 장부·행사에 같은 영수증이 있습니다. 중복 반영을 확인한 뒤 다시 업로드하세요."
        )
    for receipt, name in other:
        number = receipt.receipt_number or next(
            i for i, r in enumerate(rows(db, Receipt, receipt.event_id), 1) if r.id == receipt.id
        )
        references.setdefault(receipt.sha256, f"{name}의 영수증 #{number}")
    previous_numbers = [number for number, _ in numbered]
    for archived in db.scalars(select(FinalVersion).where(FinalVersion.event_id == event_id)):
        previous_numbers.extend(
            r.get("receipt_number") or i
            for i, r in enumerate(json.loads(archived.snapshot_json)["receipts"], 1)
        )
    next_number = max(previous_numbers, default=0) + 1
    annual_scope = db.scalar(select(AnnualBook).where(AnnualBook.owner_event_id == event_id))
    folder = (
        f"{scope.scope_type}/{annual_scope.year}/{event_id}"
        if annual_scope
        else f"event/{event_id}"
    )
    saved = []
    uploaded = []
    pending = []
    try:
        for name, suffix, raw, digest in images:
            reference = references.get(digest)
            rel = f"receipts/{folder}/{uuid.uuid4().hex}{suffix}"
            path = STORAGE / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            saved.append(path)
            receipt = Receipt(
                event_id=event_id,
                receipt_number=next_number,
                original_name=name,
                stored_path=rel,
                sha256=digest,
                ocr_status="제외" if reference else "대기",
                review_reason=(
                    f"동일 파일 중복 · 기준: {reference}"
                    if reference
                    else "OCR 분석 또는 수동 입력 필요"
                ),
            )
            db.add(receipt)
            uploaded.append(receipt)
            if not reference:
                pending.append(receipt)
                references[digest] = f"영수증 #{next_number}"
            next_number += 1
        touch(db, event_id)
        db.commit()
    except Exception:
        db.rollback()
        for p in saved:
            p.unlink(missing_ok=True)
        raise
    return {
        "uploaded_count": len(uploaded),
        "uploaded_receipt_ids": [receipt.id for receipt in uploaded],
        "analysis_receipt_ids": [receipt.id for receipt in pending],
        "duplicate_count": len(uploaded) - len(pending),
        "cross_scope_duplicate_count": len(other),
    }


@app.get("/api/events/{event_id}/receipts")
def receipts(event_id: int, db: Session = Depends(session)):
    get(db, Event, event_id)
    return [encode(r) for r in rows(db, Receipt, event_id)]


@app.get("/api/receipts/{receipt_id}/image")
def receipt_image(receipt_id: int, db: Session = Depends(session)):
    r = get(db, Receipt, receipt_id)
    return FileResponse(
        STORAGE / r.stored_path,
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"},
    )


@app.patch("/api/receipts/{receipt_id}")
def receipt_edit(receipt_id: int, data: ReceiptIn, db: Session = Depends(session)):
    r = get(db, Receipt, receipt_id)
    if r.ocr_status == "확인됨":
        raise HTTPException(409, "확인된 영수증은 재검토를 시작한 뒤 수정하세요.")
    if any(j["event_id"] == r.event_id and j["status"] == "running" for j in JOBS.values()):
        raise HTTPException(409, "OCR 완료 후 수정하세요.")
    for k, v in data.model_dump().items():
        setattr(
            r,
            k,
            (
                (
                    v.astimezone(ZoneInfo("Asia/Seoul")).replace(tzinfo=None) if v.tzinfo else v
                ).isoformat(timespec="seconds")
                if isinstance(v, datetime)
                else v.isoformat() if isinstance(v, date) else v
            ),
        )
    allocated = sum(
        l.allocated_amount_krw or 0 for l in db.scalars(select(Link).where(Link.receipt_id == r.id))
    )
    if allocated and (r.final_amount_krw is None or allocated > r.final_amount_krw):
        raise HTTPException(422, "배분금액보다 작은 결제금액을 저장할 수 없습니다.")
    reasons = [data.review_reason] if data.review_reason else []
    if not r.transaction_at:
        reasons.append("거래일시 누락")
    if r.final_amount_krw is None:
        reasons.append("결제금액 누락")
    r.review_reason = "; ".join(reasons)
    r.ocr_status = "확인됨"
    r.edited_at = now()
    touch(db, r.event_id)
    db.commit()
    return encode(r)


@app.post("/api/receipts/{receipt_id}/review")
def receipt_review(receipt_id: int, db: Session = Depends(session)):
    r = get(db, Receipt, receipt_id)
    if r.ocr_status == "확인됨":
        r.ocr_status = "검토 필요"
        r.edited_at = now()
        touch(db, r.event_id)
        db.commit()
    return encode(r)


@app.delete("/api/receipts/{receipt_id}", status_code=204)
def receipt_delete(receipt_id: int, db: Session = Depends(session)):
    r = get(db, Receipt, receipt_id)
    delete_receipts(db, r.event_id, [r])


@app.delete("/api/events/{event_id}/receipts", status_code=204)
def receipt_bulk_delete(event_id: int, data: ReceiptSelectionIn, db: Session = Depends(session)):
    selected = scoped_receipts(db, event_id, data.receipt_ids)
    delete_receipts(db, event_id, selected)


@app.post("/api/events/{event_id}/receipts/confirm")
def receipt_bulk_confirm(event_id: int, data: ReceiptSelectionIn, db: Session = Depends(session)):
    selected = scoped_receipts(db, event_id, data.receipt_ids)
    pending = [r for r in selected if r.ocr_status in ("대기", "검토 필요")]
    if pending:
        timestamp = now()
        for r in pending:
            r.ocr_status = "확인됨"
            r.edited_at = timestamp
        touch(db, event_id)
        db.commit()
    return {"confirmed_count": len(pending)}


def scoped_receipts(db, event_id, receipt_ids):
    ids = set(receipt_ids)
    selected = [r for r in rows(db, Receipt, event_id) if r.id in ids]
    if len(selected) != len(ids):
        raise HTTPException(422, "현재 장부나 행사에 있는 영수증만 선택하세요.")
    return selected


def delete_receipts(db, event_id, selected):
    paths = [STORAGE / r.stored_path for r in selected]
    touch(db, event_id)
    for r in selected:
        db.delete(r)
    db.commit()
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            log.exception("영수증 원본 파일 삭제 실패: %s", path)


def generate_receipt_draft(db, receipt, result, source_type="ocr"):
    from .annual_service import by_event, ensure_other_budget_item, sync_generated_entry

    duplicates = [receipt]
    if receipt.transaction_at and receipt.final_amount_krw is not None:
        duplicates = list(
            db.scalars(
                select(Receipt).where(
                    Receipt.event_id == receipt.event_id,
                    Receipt.ocr_status != "제외",
                    func.substr(Receipt.transaction_at, 1, 10) == receipt.transaction_at[:10],
                    Receipt.final_amount_krw == receipt.final_amount_krw,
                )
            )
        )
    r = min(
        duplicates, key=lambda r: (len(r.transaction_at or "") < 16, r.transaction_at or "", r.id)
    )
    linked = list(
        db.execute(
            select(Link, Expense)
            .join(Expense, Expense.id == Link.expense_id)
            .where(Link.receipt_id.in_([item.id for item in duplicates]))
            .order_by(Expense.id)
        )
    )
    for _link, expense in linked:
        if (
            expense.source_type not in ("ocr", "llm")
            or expense.edited_by != expense.source_type
            or db.scalar(
                select(func.count()).select_from(Link).where(Link.expense_id == expense.id)
            )
            != 1
        ):
            return
    kept = next(
        (pair for pair in linked if pair[0].receipt_id == r.id), linked[0] if linked else None
    )
    for pair in linked:
        if pair is not kept:
            _, duplicate = pair
            audit(
                db,
                receipt.event_id,
                "auto_draft_duplicate",
                encode(duplicate),
                None,
                duplicate.id,
                source_type,
            )
            db.delete(duplicate)
    if r.id != receipt.id:
        extraction = db.scalar(
            select(Extraction)
            .where(Extraction.receipt_id == r.id)
            .order_by(Extraction.id.desc())
            .limit(1)
        )
        result = json.loads(extraction.extracted_json) if extraction else {}
        source_type = (
            "llm"
            if extraction
            and extraction.input_kind in ("image", "text")
            and not extraction.error_message
            else "ocr"
        )

    event = db.get(Event, r.event_id)
    book = by_event(db, event.id) if event.scope_type != "event" else None
    categories = rows(db, Category, r.event_id)
    category = next(
        (c for c in categories if c.is_active and c.id == result.get("suggested_category_id")),
        None,
    )
    note = "영수증 분석으로 자동 생성된 초안"
    if category is None:
        if book and book.kind == "ordinary":
            item = ensure_other_budget_item(db, book, event)
            category = db.get(Category, item.category_id)
            note += " · [임시 분류: 기타]"
        else:
            name = "미분류" if book and book.kind == "b" else "기타"
            category = next((c for c in categories if c.name == name), None)
            if category is None:
                category = Category(event_id=event.id, name=name, sort_order=len(categories))
                db.add(category)
            category.is_active = True
            db.flush()
    stamp = r.transaction_at or result.get("transaction_at")
    amount = r.final_amount_krw if r.final_amount_krw is not None else result.get("final_amount_krw")
    item_name = (r.description or result.get("description") or "")[:500]
    vendor = r.merchant or result.get("merchant") or ""
    reuse_link = bool(kept and kept[0].receipt_id == r.id)
    if kept:
        previous_link, x = kept
        before = encode(x)
        if not reuse_link:
            db.delete(previous_link)
    else:
        previous_link, before = None, None
        x = Expense(
            event_id=r.event_id,
            purchased=False,
            sort_order=len(rows(db, Expense, r.event_id)),
            review_status="검토 필요",
        )
    x.category_id = category.id
    x.expense_date = stamp[:10] if stamp else None
    x.item_name = item_name
    x.amount_krw = amount
    x.vendor = vendor
    x.note = note
    x.source_type = source_type
    x.edited_by = source_type
    x.edited_at = now()
    db.add(x)
    db.flush()
    if reuse_link:
        previous_link.allocated_amount_krw = amount
    else:
        db.add(Link(expense_id=x.id, receipt_id=r.id, allocated_amount_krw=amount))
    if book:
        sync_generated_entry(db, event, x, update_existing=kept is not None)
    audit(db, r.event_id, "auto_draft", before, encode(x), x.id, source_type)


def update_job(job_id, **values):
    with JOB_LOCK:
        JOBS[job_id].update(values)
    with SessionLocal() as db:
        state = db.get(ProcessingJob, job_id)
        if state:
            for key, value in values.items():
                setattr(state, key, value)
            db.commit()


def run_ocr(job_id, ids):
    with OCR_LOCK:
        try:
            for index, id in enumerate(ids, 1):
                with SessionLocal() as db:
                    r = db.get(Receipt, id)
                    if not r:
                        continue
                    event = db.get(Event, r.event_id)
                    if not event or event.status == FINAL:
                        continue
                    # Vision mode can scan images without PaddleOCR being installed.
                    try:
                        vision_only = (
                            LLMSettings.read().enabled and LLMSettings.read().mode == "vision"
                        )
                    except (ValueError, TypeError):
                        vision_only = False
                    try:
                        result = (
                            parse_receipt("")
                            if vision_only
                            else parse_receipt(recognize(str(STORAGE / r.stored_path)))
                        )
                    except ImportError:
                        result = parse_receipt("")
                        result["review_reason"] = (
                            "OCR 엔진 미설치: LLM 이미지 분석을 설정하거나 PaddleOCR를 설치하세요."
                        )
                    except Exception:
                        result = parse_receipt("")
                        result["review_reason"] = (
                            "OCR 분석 실패. 원본을 확인하거나 LLM 이미지 분석을 설정하세요."
                        )
                    rule_result = dict(result)
                    if not vision_only:
                        db.add(
                            Extraction(
                                processing_job_id=job_id,
                                receipt_id=r.id,
                                ocr_raw_text=result.get("ocr_text", ""),
                                extracted_json=json.dumps(rule_result, ensure_ascii=False),
                                model_name="PaddleOCR / rules",
                                input_kind="ocr",
                            )
                        )
                    from .annual_service import context_categories

                    llm = extract_receipt(
                        str(STORAGE / r.stored_path),
                        result.get("ocr_text", ""),
                        rule_result,
                        context_categories(db, event),
                    )
                    if llm.candidate:
                        result = llm.candidate
                        if (
                            "취소" in rule_result.get("review_reason", "")
                            and "취소" not in result["review_reason"]
                        ):
                            result["review_reason"] += "; 취소·환불 영수증 확인"
                    if llm.error:
                        result["review_reason"] = "; ".join(
                            filter(None, [result.get("review_reason"), llm.error])
                        )
                    if llm.attempted or llm.error:
                        db.add(
                            Extraction(
                                processing_job_id=job_id,
                                receipt_id=r.id,
                                ocr_raw_text=rule_result.get("ocr_text", ""),
                                extracted_json=json.dumps(result, ensure_ascii=False),
                                model_name=llm.model_name or "LLM",
                                input_kind=llm.input_kind or "none",
                                usage_json=json.dumps(llm.usage),
                                estimated_cost_usd=llm.estimated_cost_usd,
                                error_message=llm.error,
                            )
                        )
                    if r.ocr_status == "대기" or not r.edited_at:
                        for k, v in result.items():
                            if hasattr(type(r), k):
                                setattr(r, k, v)
                    if r.ocr_status == "대기":
                        r.ocr_status = "검토 필요"
                    generate_receipt_draft(
                        db, r, result, source_type="llm" if llm.candidate else "ocr"
                    )
                    touch(db, r.event_id)
                    db.commit()
                update_job(job_id, processed=index)
            update_job(job_id, status="completed")
        except Exception:
            log.exception("OCR job failed: %s", job_id)
            update_job(
                job_id,
                status="failed",
                error_message="처리가 중단되었습니다. 저장된 결과를 확인하고 다시 분석하세요.",
            )


@app.post("/api/events/{event_id}/receipts/analyze", status_code=202)
def analyze(
    event_id: int,
    background: BackgroundTasks,
    db: Session = Depends(session),
    data: ReceiptAnalysisIn | None = None,
):
    get(db, Event, event_id)
    with JOB_LOCK:
        active = next(
            (j for j in JOBS.values() if j["event_id"] == event_id and j["status"] == "running"),
            None,
        )
        if active:
            if data and data.receipt_ids is not None:
                raise HTTPException(409, "진행 중인 영수증 분석이 끝난 뒤 다시 시도하세요.")
            return active
        receipts = rows(db, Receipt, event_id)
        if data and data.receipt_ids is not None:
            selected = set(data.receipt_ids)
            ids = [r.id for r in receipts if r.id in selected and r.ocr_status != "제외"]
            if len(ids) != len(selected):
                raise HTTPException(422, "이 장부의 분석 가능한 영수증만 선택하세요.")
        else:
            ids = [r.id for r in receipts if r.ocr_status == "대기"]
        if not ids:
            raise HTTPException(422, "분석할 영수증이 없습니다.")
        job = {
            "id": uuid.uuid4().hex,
            "event_id": event_id,
            "status": "running",
            "total": len(ids),
            "processed": 0,
        }
        db.add(ProcessingJob(**job))
        db.commit()
        JOBS[job["id"]] = job
    background.add_task(run_ocr, job["id"], ids)
    return job


@app.get("/api/analysis-jobs/{job_id}")
@app.get("/api/jobs/{job_id}")
def job_status(job_id: str, db: Session = Depends(session)):
    state = db.get(ProcessingJob, job_id)
    if state:
        from decimal import Decimal

        records = list(db.scalars(select(Extraction).where(Extraction.processing_job_id == job_id)))
        token_in = token_out = 0
        cost = Decimal("0")
        unpriced = 0
        for record in records:
            usage = json.loads(record.usage_json)
            token_in += usage.get("input_tokens", 0)
            token_out += usage.get("output_tokens", 0)
            if record.input_kind != "ocr":
                if record.estimated_cost_usd is None:
                    unpriced += 1
                else:
                    cost += Decimal(record.estimated_cost_usd)
        return {
            **encode(state),
            "input_tokens": token_in,
            "output_tokens": token_out,
            "estimated_cost_usd": None if unpriced else str(cost),
            "unpriced_count": unpriced,
            "analysis_error_count": sum(bool(r.error_message) for r in records),
        }
    if job_id not in JOBS:
        raise HTTPException(
            404, "서버 재시작으로 작업 상태가 초기화되었습니다. 영수증 목록에서 결과를 확인하세요."
        )
    return JOBS[job_id]


@app.get("/api/events/{event_id}/receipt-suggestions")
def suggestions(event_id: int, db: Session = Depends(session)):
    get(db, Event, event_id)
    out = []
    for r in rows(db, Receipt, event_id):
        candidates = []
        for x in rows(db, Expense, event_id):
            score = 0
            if r.final_amount_krw is not None and r.final_amount_krw == x.amount_krw:
                score += 60
            if r.transaction_at and r.transaction_at[:10] == x.expense_date:
                score += 25
            if (
                x.vendor
                and r.merchant
                and (
                    x.vendor.casefold() in r.merchant.casefold()
                    or r.merchant.casefold() in x.vendor.casefold()
                )
            ):
                score += 15
            if score >= 60:
                candidates.append({"expense_id": x.id, "score": score})
        out.append(
            {"receipt_id": r.id, "candidates": sorted(candidates, key=lambda c: -c["score"])[:3]}
        )
    return out


@app.post("/api/events/{event_id}/receipt-links")
def link_receipt(event_id: int, data: LinkIn, db: Session = Depends(session)):
    get(db, Event, event_id)
    x = get(db, Expense, data.expense_id)
    r = get(db, Receipt, data.receipt_id)
    if x.event_id != event_id or r.event_id != event_id:
        raise HTTPException(422, "같은 행사 내에서만 연결할 수 있습니다.")
    annual_entry = db.scalar(select(AnnualEntry).where(AnnualEntry.expense_id == x.id))
    if annual_entry and not annual_entry.expense_krw:
        raise HTTPException(422, "수입 거래에는 지출 영수증을 연결할 수 없습니다.")
    if r.final_amount_krw is None:
        raise HTTPException(422, "영수증 결제금액을 먼저 입력하세요.")
    total = sum(
        l.allocated_amount_krw or 0
        for l in db.scalars(select(Link).where(Link.receipt_id == r.id, Link.expense_id != x.id))
    )
    if total + data.allocated_amount_krw > r.final_amount_krw:
        raise HTTPException(422, "전체 배분액이 영수증 결제금액을 초과합니다.")
    l = db.get(Link, (x.id, r.id))
    if l:
        l.allocated_amount_krw = data.allocated_amount_krw
    else:
        db.add(Link(**data.model_dump()))
    touch(db, event_id)
    db.commit()
    return detail(db, get(db, Event, event_id))


@app.delete("/api/events/{event_id}/receipt-links/{expense_id}/{receipt_id}", status_code=204)
def unlink(event_id: int, expense_id: int, receipt_id: int, db: Session = Depends(session)):
    x = get(db, Expense, expense_id)
    r = get(db, Receipt, receipt_id)
    if x.event_id != event_id or r.event_id != event_id:
        raise HTTPException(422, "다른 행사 데이터입니다.")
    l = db.get(Link, (expense_id, receipt_id))
    if not l:
        raise HTTPException(404, "연결을 찾을 수 없습니다.")
    db.delete(l)
    touch(db, event_id)
    db.commit()


@app.post("/api/receipts/{receipt_id}/create-expense", status_code=201)
def expense_from_receipt(receipt_id: int, category_id: int, db: Session = Depends(session)):
    r = get(db, Receipt, receipt_id)
    if not r.transaction_at or r.final_amount_krw is None or r.ocr_status != "확인됨":
        raise HTTPException(422, "거래일시·금액을 입력하고 검토를 완료하세요.")
    if db.scalar(select(Link).where(Link.receipt_id == r.id)):
        raise HTTPException(409, "이미 지출에 연결된 영수증입니다.")
    valid_category(db, r.event_id, category_id)
    x = Expense(
        event_id=r.event_id,
        category_id=category_id,
        expense_date=r.transaction_at[:10],
        item_name=r.description or r.merchant or "영수증 지출",
        amount_krw=r.final_amount_krw,
        vendor=r.merchant,
        purchased=True,
        sort_order=len(rows(db, Expense, r.event_id)),
    )
    db.add(x)
    db.flush()
    db.add(Link(expense_id=x.id, receipt_id=r.id, allocated_amount_krw=r.final_amount_krw))
    e = get(db, Event, r.event_id)
    if e.scope_type != "event":
        from .annual_service import sync_generated_entry

        sync_generated_entry(db, e, x)
    touch(db, r.event_id)
    db.commit()
    return encode(x)


@app.get("/api/events/{event_id}/receipts/export-zip")
def export_receipts(
    event_id: int,
    version: int | None = None,
    draft: bool = False,
    db: Session = Depends(session),
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
):
    e = get(db, Event, event_id)
    if version or (e.latest_final_version and not draft):
        row = version_row(db, e, version)
        snap = json.loads(row.snapshot_json)
        filename = f'{snap["name"]}_v{row.version_no}_영수증.zip'
    elif draft:
        rs = rows(db, Receipt, event_id)
        if not rs:
            raise HTTPException(422, "영수증이 없습니다.")
        snap = {"receipts": [{**encode(r), "stored_path": r.stored_path} for r in rs]}
        filename = f"DRAFT_{e.name}_영수증.zip"
    else:
        raise HTTPException(422, "확정본이 없습니다. 먼저 최종 확정하거나 초안 ZIP을 선택하세요.")
    if from_date or to_date:
        start = from_date.isoformat() if from_date else ""
        end = to_date.isoformat() if to_date else ""
        if start and end and start > end:
            raise HTTPException(422, "출력 시작일은 종료일 이전이어야 합니다.")
        snap["receipts"] = [
            r
            for r in snap["receipts"]
            if not (day := (r.get("transaction_at") or "")[:10])
            or (not start or day >= start)
            and (not end or day <= end)
        ]
        if not snap["receipts"]:
            raise HTTPException(422, "선택한 범위에 출력할 영수증이 없습니다.")
    return download(receipt_archive(snap), "application/zip", filename)


@app.get("/api/receipts/{receipt_id}/extractions")
def extraction_history(receipt_id: int, db: Session = Depends(session)):
    get(db, Receipt, receipt_id)
    return [
        encode(x)
        for x in db.scalars(
            select(Extraction)
            .where(Extraction.receipt_id == receipt_id)
            .order_by(Extraction.id.desc())
        )
    ]


@app.get("/api/events/{event_id}/changes")
def changes(event_id: int, db: Session = Depends(session)):
    get(db, Event, event_id)
    return [
        encode(x)
        for x in db.scalars(
            select(ChangeLog)
            .where(ChangeLog.event_id == event_id)
            .order_by(ChangeLog.id.desc())
            .limit(200)
        )
    ]


@app.post("/api/events/{event_id}/review")
def review_event(event_id: int, data: RevisionIn, db: Session = Depends(session)):
    e = get(db, Event, event_id)
    if e.version != data.version:
        raise HTTPException(409, "오래된 초안입니다. 다시 열어주세요.")
    e.status = "재수정중" if e.latest_final_version else "검토중"
    touch(db, event_id)
    db.commit()
    return detail(db, e)


@app.get("/api/events/{event_id}/finalize/check")
def finalize_check(event_id: int, db: Session = Depends(session)):
    e = get(db, Event, event_id)
    result = check(db, e)
    if any(j["event_id"] == event_id and j["status"] == "running" for j in JOBS.values()):
        result["errors"].append("영수증 분석이 진행 중입니다.")
        result["can_finalize"] = False
    return result


@app.post("/api/events/{event_id}/finalize")
def finalize(event_id: int, data: FinalizeIn, db: Session = Depends(session)):
    import shutil

    e = get(db, Event, event_id)
    if e.version != data.version:
        raise HTTPException(409, "오래된 초안입니다. 다시 열어주세요.")
    if e.status not in ["작성중", "검토중", "재수정중"]:
        raise HTTPException(422, "편집 가능한 초안만 확정할 수 있습니다.")
    result = finalize_check(event_id, db)
    if result["errors"]:
        raise HTTPException(422, " / ".join(result["errors"]))
    if result["warnings"] and (not data.acknowledge_warnings or not data.approval_reason.strip()):
        raise HTTPException(422, "경고를 확인하고 승인 사유를 입력하세요.")
    number = e.latest_final_version + 1
    snap = detail(db, e)
    if e.scope_type != "event":
        from .annual_service import annual_snapshot

        snap["annual"] = annual_snapshot(db, e)
    snap.update(
        status=FINAL,
        final_version=number,
        approval_reason=data.approval_reason,
        finalized_at=now(),
        finalized_by="local-user",
    )
    folder = STORAGE / "versions" / str(event_id) / f"{number}_{uuid.uuid4().hex}"
    try:
        for r in rows(db, Receipt, event_id):
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / f"{r.id}_{r.sha256}{Path(r.stored_path).suffix}"
            shutil.copyfile(STORAGE / r.stored_path, target)
            next(x for x in snap["receipts"] if x["id"] == r.id)["stored_path"] = str(
                target.relative_to(STORAGE)
            )
        db.add(
            FinalVersion(
                event_id=event_id,
                version_no=number,
                snapshot_json=json.dumps(snap, ensure_ascii=False),
                total_krw=result["total_krw"],
                approval_reason=data.approval_reason,
            )
        )
        audit(db, event_id, "finalize", e.latest_final_version, number)
        e.latest_final_version = number
        e.status = FINAL
        e.version += 1
        e.updated_at = now()
        db.commit()
    except Exception:
        db.rollback()
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return detail(db, e)


@app.post("/api/events/{event_id}/reopen")
def reopen(event_id: int, data: RevisionIn, db: Session = Depends(session)):
    e = get(db, Event, event_id)
    if e.version != data.version:
        raise HTTPException(409, "오래된 버전입니다. 다시 열어주세요.")
    if e.status != FINAL:
        raise HTTPException(409, "확정된 행사만 재오픈할 수 있습니다.")
    audit(db, event_id, "reopen", e.latest_final_version, "재수정중")
    e.status = "재수정중"
    e.version += 1
    e.updated_at = now()
    db.commit()
    return detail(db, e)


@app.get("/api/events/{event_id}/versions")
def versions(event_id: int, db: Session = Depends(session)):
    get(db, Event, event_id)
    return [
        {k: v for k, v in encode(x).items() if k != "snapshot_json"}
        for x in db.scalars(
            select(FinalVersion)
            .where(FinalVersion.event_id == event_id)
            .order_by(FinalVersion.version_no.desc())
        )
    ]


@app.get("/api/events/{event_id}/versions/{version_no}")
def version_detail(event_id: int, version_no: int, db: Session = Depends(session)):
    e = get(db, Event, event_id)
    return json.loads(version_row(db, e, version_no).snapshot_json)


def restore_excluded(db, r):
    if r.ocr_status != "제외":
        return None
    reviewed = bool(
        r.ocr_text
        or r.transaction_at
        or (r.merchant or "").strip()
        or (r.description or "").strip()
        or r.final_amount_krw is not None
        or db.scalar(select(Extraction.id).where(Extraction.receipt_id == r.id).limit(1))
    )
    r.ocr_status = "검토 필요" if reviewed else "대기"
    audit(db, r.event_id, "receipt_restored", "제외", r.ocr_status)
    return r


@app.post("/api/receipts/{receipt_id}/exclude")
def exclude_receipt(receipt_id: int, db: Session = Depends(session)):
    r = get(db, Receipt, receipt_id)
    if db.scalar(select(Link).where(Link.receipt_id == receipt_id)):
        raise HTTPException(409, "연결된 지출을 확인하고 영수증 연결을 해제한 뒤 제외하세요.")
    r.ocr_status = "제외"
    r.review_reason = "중복 영수증 사용자 제외"
    r.edited_at = now()
    audit(db, r.event_id, "receipt_excluded", None, r.id)
    touch(db, r.event_id)
    db.commit()
    return encode(r)


@app.post("/api/receipts/{receipt_id}/restore")
def restore_receipt(receipt_id: int, db: Session = Depends(session)):
    r = get(db, Receipt, receipt_id)
    if not restore_excluded(db, r):
        raise HTTPException(409, "제외된 영수증만 대기 또는 검토 상태로 되돌릴 수 있습니다.")
    touch(db, r.event_id)
    db.commit()
    return encode(r)


@app.post("/api/events/{event_id}/receipts/restore")
def receipt_bulk_restore(event_id: int, data: ReceiptSelectionIn, db: Session = Depends(session)):
    restored = [restore_excluded(db, r) for r in scoped_receipts(db, event_id, data.receipt_ids)]
    restored = [r for r in restored if r]
    if restored:
        touch(db, event_id)
        db.commit()
    return {"restored_count": len(restored)}


@app.get("/api/events/{event_id}/receipts/export-pptx")
def event_ppt(
    event_id: int,
    version: int | None = None,
    draft: bool = False,
    include_unverified: bool = False,
    per_slide: int = 3,
    db: Session = Depends(session),
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
):
    from .ppt import generate_ppt, MIME

    e = get(db, Event, event_id)
    if version or (e.latest_final_version and not draft):
        snap = json.loads(version_row(db, e, version).snapshot_json)
    elif draft:
        snap = detail(db, e)
        snap["receipts"] = [
            {**encode(r), "stored_path": r.stored_path} for r in rows(db, Receipt, event_id)
        ]
    else:
        raise HTTPException(422, "확정본이 없습니다. 초안 출력 옵션을 선택하세요.")
    return download(
        generate_ppt(
            snap,
            from_date.isoformat() if from_date else "",
            to_date.isoformat() if to_date else "",
            include_unverified=include_unverified,
            per_slide=per_slide,
        ),
        MIME,
        f'{"DRAFT_" if not snap.get("final_version") else ""}{snap["name"]}_영수증증빙자료.pptx',
    )


class ScopeAnalysisRequest(BaseModel):
    scope_type: Literal["event", "ordinary", "b"]
    scope_id: int


class ScopedReceiptAnalysisIn(ScopeAnalysisRequest, ReceiptAnalysisIn):
    pass


def scope_event(db, scope_type, scope_id):
    if scope_type == "event":
        event = get(db, Event, scope_id)
        if event.scope_type != "event":
            raise HTTPException(422, "행사비 범위가 아닙니다.")
        return event
    from .annual_service import get_book

    book = get_book(db, scope_type, scope_id)
    return get(db, Event, book.owner_event_id)


@app.post("/api/receipts/upload")
async def shared_upload(
    scope_type: Literal["event", "ordinary", "b"] = Form(...),
    scope_id: int = Form(...),
    file: UploadFile = File(...),
    confirm_reuse: bool = Form(False),
    db: Session = Depends(session),
):
    event = scope_event(db, scope_type, scope_id)
    editable(db, event.id)
    if any(j["event_id"] == event.id and j["status"] == "running" for j in JOBS.values()):
        raise HTTPException(409, "분석 완료 후 업로드하세요.")
    return await receipt_upload(event.id, file, db, confirm_reuse)


@app.post("/api/analysis-jobs", status_code=202)
def shared_analyze(
    data: ScopedReceiptAnalysisIn, background: BackgroundTasks, db: Session = Depends(session)
):
    event = scope_event(db, data.scope_type, data.scope_id)
    editable(db, event.id)
    return analyze(event.id, background, db, data)


class ScopeLinkRequest(ScopeAnalysisRequest):
    target_id: int
    receipt_id: int
    allocated_amount_krw: int = Field(ge=0, le=10**12, strict=True)


@app.post("/api/receipt-links")
def shared_link(data: ScopeLinkRequest, db: Session = Depends(session)):
    event = scope_event(db, data.scope_type, data.scope_id)
    editable(db, event.id)
    if any(j["event_id"] == event.id and j["status"] == "running" for j in JOBS.values()):
        raise HTTPException(409, "분석 완료 후 연결하세요.")
    target = data.target_id
    if data.scope_type != "event":
        entry = get(db, AnnualEntry, target)
        if entry.book_id != data.scope_id:
            raise HTTPException(422, "다른 장부의 거래입니다.")
        target = entry.expense_id
    return link_receipt(
        event.id,
        LinkIn(
            expense_id=target,
            receipt_id=data.receipt_id,
            allocated_amount_krw=data.allocated_amount_krw,
        ),
        db,
    )


@app.post("/api/scopes/{scope_type}/{scope_id}/confirm")
def shared_confirm(
    scope_type: Literal["event", "ordinary", "b"],
    scope_id: int,
    data: FinalizeIn,
    db: Session = Depends(session),
):
    event = scope_event(db, scope_type, scope_id)
    editable(db, event.id)
    return finalize(event.id, data, db)


@app.post("/api/scopes/{scope_type}/{scope_id}/revise")
def shared_revise(
    scope_type: Literal["event", "ordinary", "b"],
    scope_id: int,
    data: RevisionIn,
    db: Session = Depends(session),
):
    return reopen(scope_event(db, scope_type, scope_id).id, data, db)


from .annual_api import router as annual_router

app.include_router(annual_router)
