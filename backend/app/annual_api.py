import json
import uuid
from datetime import date
from typing import Literal
from fastapi import (
    BackgroundTasks,
    APIRouter,
    Depends,
    HTTPException,
    UploadFile,
    File,
    Form,
    Query,
)
from sqlalchemy import select
from sqlalchemy.orm import Session
from .db import session
from .models import (
    AnnualBook,
    AnnualEntry,
    BudgetItem,
    Event,
    Expense,
    Category,
    ImportJob,
    FinalVersion,
    Receipt,
    Link,
    now,
)
from .annual_schemas import BookIn, BudgetSave, BudgetIn, EntrySave, EntryIn
from .annual_service import (
    get_book,
    by_event,
    budget_rows,
    entries,
    budget_path,
    book_detail,
    annual_snapshot,
    apply_entry,
    ensure_other_budget_item,
    sync_budget_category,
    encode,
    LABEL,
)
from .annual_excel import parse_workbook, export_book
from .church_ledger import export_church_ledger
from .schemas import RevisionIn, FinalizeIn, CommitIn, ReceiptAnalysisIn
from .workflow import editable, audit, version_row, receipt_archive
from .ppt import generate_ppt, MIME, select_receipts

router = APIRouter(prefix="/api")
Kind = Literal["ordinary", "b"]


def owner(db, book):
    return db.get(Event, book.owner_event_id)


def ensure_editable(db, book, version=None):
    e = editable(db, book.owner_event_id)
    if version is not None and e.version != version:
        raise HTTPException(409, "다른 작업에서 장부가 변경되었습니다. 다시 열어 확인하세요.")
    return e


def apply_budget(db, book, data):
    if book.kind != "ordinary":
        raise HTTPException(422, "B 장부에는 예산표가 없습니다.")
    event = ensure_editable(db, book, data.version)
    old = budget_rows(db, book)
    old_state = [encode(i) for i in old]
    oldmap = {i.id: i for i in old}
    prepared = {}
    ids = []
    for n, b in enumerate(data.items):
        key = b.id if b.id is not None else -(n + 100000)
        if key in prepared or key == 0 or (key > 0 and key not in oldmap):
            raise HTTPException(422, "잘못되거나 중복된 예산 항목 ID입니다.")
        prepared[key] = b
        ids.append(key)
    paths = set()
    for key, b in prepared.items():
        if b.level == 1:
            if b.parent_id is not None:
                raise HTTPException(422, "관에는 상위 항목을 지정할 수 없습니다.")
        elif b.parent_id not in prepared or prepared[b.parent_id].level != b.level - 1:
            raise HTTPException(422, "관 → 항 → 목 순서로 같은 장부의 상위 항목을 지정하세요.")
        if b.level != 3 and b.budget_krw:
            raise HTTPException(422, "예산은 목 레벨에만 입력하세요.")
        sig = (b.parent_id, b.name)
        if sig in paths:
            raise HTTPException(422, "같은 상위 항목에 중복된 이름이 있습니다.")
        paths.add(sig)
    used = {x.budget_item_id for x in entries(db, book) if x.budget_item_id}
    if event.latest_final_version:
        snap = json.loads(version_row(db, event).snapshot_json)
        used |= {
            x["budget_item_id"]
            for x in snap.get("annual", {}).get("entries", [])
            if x["budget_item_id"]
        }
    deleting = set(oldmap) - {x for x in prepared if x > 0}
    if used & deleting:
        raise HTTPException(
            409,
            "거래 또는 확정본에서 사용 중인 목은 삭제할 수 없습니다. 비활성화하거나 거래를 이관하세요.",
        )
    changed = {}
    newitems = []
    for level in [1, 2, 3]:
        for key in ids:
            b = prepared[key]
            if b.level != level:
                continue
            item = oldmap.get(key) or BudgetItem(book_id=book.id)
            item.parent_id = changed[b.parent_id].id if b.parent_id else None
            for field, value in b.model_dump(exclude={"id", "parent_id"}).items():
                setattr(item, field, value)
            if item.parent_id:
                item.is_active = item.is_active and changed[b.parent_id].is_active
            item.updated_at = now()
            db.add(item)
            db.flush()
            changed[key] = item
            newitems.append(item)
    for item in newitems:
        if item.level == 3:
            sync_budget_category(db, event, item, budget_path(item, newitems))
    for item in sorted((oldmap[i] for i in deleting), key=lambda x: -x.level):
        if item.category_id:
            db.get(Category, item.category_id).is_active = False
        db.delete(item)
    audit(db, event.id, "budget", old_state, [b.model_dump() for b in data.items])
    event.version += 1
    event.updated_at = now()
    db.flush()


def apply_entries(db, book, data, source="manual"):
    event = ensure_editable(db, book, data.version)
    old = {x.id: x for x in entries(db, book)}
    keep = set()
    for n, entry in enumerate(data.entries):
        if entry.id:
            if entry.id not in old or entry.id in keep:
                raise HTTPException(422, "잘못되거나 중복된 거래 ID입니다.")
            obj = old[entry.id]
            keep.add(obj.id)
        else:
            obj = AnnualEntry(book_id=book.id, source_type=source)
        entry = entry.model_copy(update={"sort_order": n})
        with db.no_autoflush:
            apply_entry(db, book, event, obj, entry)
        db.add(obj)
        db.flush()
    for key, obj in old.items():
        if key not in keep:
            audit(db, event.id, "annual_entry_delete", encode(obj), None, obj.expense_id)
            db.delete(db.get(Expense, obj.expense_id))
    event.version += 1
    event.updated_at = now()
    db.flush()


@router.get("/{kind}/books")
def list_books(kind: Kind, db: Session = Depends(session)):
    return [
        book_detail(db, b)
        for b in db.scalars(
            select(AnnualBook).where(AnnualBook.kind == kind).order_by(AnnualBook.year.desc())
        )
    ]


@router.post("/{kind}/books", status_code=201)
def create_book(kind: Kind, data: BookIn, db: Session = Depends(session)):
    if db.scalar(select(AnnualBook).where(AnnualBook.kind == kind, AnnualBook.year == data.year)):
        raise HTTPException(409, "해당 연도의 장부가 이미 있습니다.")
    if kind == "b" and data.copy_budget_from:
        raise HTTPException(422, "B에는 예산 복사 기능이 없습니다.")
    source = get_book(db, "ordinary", data.copy_budget_from) if data.copy_budget_from else None
    event = Event(
        name=f"{LABEL[kind]} {data.year}년",
        scope_type=kind,
        event_date=f"{data.year}-12-31",
        start_date=f"{data.year}-01-01",
        end_date=f"{data.year}-12-31",
    )
    db.add(event)
    db.flush()
    db.add(Category(event_id=event.id, name="미분류", sort_order=9999, color="#e5e7eb"))
    book = AnnualBook(kind=kind, year=data.year, owner_event_id=event.id)
    db.add(book)
    db.flush()
    if source:
        items = budget_rows(db, source)
        remap = {i.id: -(n + 1) for n, i in enumerate(items)}
        payload = [
            BudgetIn(
                id=remap[i.id],
                parent_id=remap.get(i.parent_id),
                level=i.level,
                name=i.name,
                budget_krw=i.budget_krw,
                detail=i.detail,
                sort_order=i.sort_order,
                is_active=i.is_active,
            )
            for i in items
        ]
        apply_budget(db, book, BudgetSave(version=event.version, items=payload))
    db.commit()
    return book_detail(db, book)


@router.get("/{kind}/books/{book_id}")
def get_detail(kind: Kind, book_id: int, db: Session = Depends(session)):
    return book_detail(db, get_book(db, kind, book_id))


@router.get("/{kind}/books/{book_id}/budget")
def get_budget(kind: Kind, book_id: int, db: Session = Depends(session)):
    b = get_book(db, kind, book_id)
    if kind != "ordinary":
        raise HTTPException(404, "B 장부에는 예산표가 없습니다.")
    return book_detail(db, b)["budget"]


@router.put("/{kind}/books/{book_id}/budget")
def save_budget(kind: Kind, book_id: int, data: BudgetSave, db: Session = Depends(session)):
    b = get_book(db, kind, book_id)
    apply_budget(db, b, data)
    db.commit()
    return book_detail(db, b)


@router.get("/{kind}/books/{book_id}/entries")
def get_entries(
    kind: Kind,
    book_id: int,
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    db: Session = Depends(session),
):
    b = get_book(db, kind, book_id)
    return [
        encode(x)
        for x in entries(db, b)
        if (not from_date or (x.transaction_date or "") >= from_date.isoformat())
        and (not to_date or (x.transaction_date or "") <= to_date.isoformat())
    ]


@router.put("/{kind}/books/{book_id}/entries")
@router.post("/{kind}/books/{book_id}/draft/save")
def save_entries(kind: Kind, book_id: int, data: EntrySave, db: Session = Depends(session)):
    b = get_book(db, kind, book_id)
    apply_entries(db, b, data)
    db.commit()
    return book_detail(db, b)


@router.post("/{kind}/books/{book_id}/entries", status_code=201)
def add_entry(kind: Kind, book_id: int, data: EntryIn, db: Session = Depends(session)):
    b = get_book(db, kind, book_id)
    event = ensure_editable(db, b)
    obj = AnnualEntry(book_id=b.id, source_type="manual")
    if data.id:
        raise HTTPException(422, "새 거래에는 ID를 지정할 수 없습니다.")
    with db.no_autoflush:
        apply_entry(db, b, event, obj, data)
    db.add(obj)
    event.version += 1
    event.updated_at = now()
    db.commit()
    return encode(obj)


@router.patch("/{kind}/entries/{entry_id}")
def update_entry(kind: Kind, entry_id: int, data: EntryIn, db: Session = Depends(session)):
    obj = db.get(AnnualEntry, entry_id)
    if not obj:
        raise HTTPException(404, "거래를 찾을 수 없습니다.")
    b = get_book(db, kind, obj.book_id)
    event = ensure_editable(db, b)
    with db.no_autoflush:
        apply_entry(db, b, event, obj, data)
    event.version += 1
    event.updated_at = now()
    db.commit()
    return encode(obj)


@router.delete("/{kind}/entries/{entry_id}", status_code=204)
def delete_entry(kind: Kind, entry_id: int, db: Session = Depends(session)):
    x = db.get(AnnualEntry, entry_id)
    if not x:
        raise HTTPException(404, "거래를 찾을 수 없습니다.")
    b = get_book(db, kind, x.book_id)
    event = ensure_editable(db, b)
    audit(db, event.id, "annual_entry_delete", encode(x), None, x.expense_id)
    db.delete(db.get(Expense, x.expense_id))
    event.version += 1
    event.updated_at = now()
    db.commit()


@router.post("/{kind}/books/{book_id}/review")
def review_book(kind: Kind, book_id: int, data: RevisionIn, db: Session = Depends(session)):
    from .main import review_event

    b = get_book(db, kind, book_id)
    review_event(b.owner_event_id, data, db)
    return book_detail(db, b)


@router.get("/{kind}/books/{book_id}/finalize/check")
def check_book(kind: Kind, book_id: int, db: Session = Depends(session)):
    from .main import finalize_check

    b = get_book(db, kind, book_id)
    return finalize_check(b.owner_event_id, db)


@router.post("/{kind}/books/{book_id}/finalize")
@router.post("/{kind}/books/{book_id}/confirm")
def finalize_book(kind: Kind, book_id: int, data: FinalizeIn, db: Session = Depends(session)):
    from .main import finalize

    b = get_book(db, kind, book_id)
    ensure_editable(db, b)
    finalize(b.owner_event_id, data, db)
    return book_detail(db, b)


@router.post("/{kind}/books/{book_id}/reopen")
def reopen_book(kind: Kind, book_id: int, data: RevisionIn, db: Session = Depends(session)):
    from .main import reopen

    b = get_book(db, kind, book_id)
    reopen(b.owner_event_id, data, db)
    return book_detail(db, b)


@router.get("/{kind}/books/{book_id}/versions")
def book_versions(kind: Kind, book_id: int, db: Session = Depends(session)):
    from .main import versions

    b = get_book(db, kind, book_id)
    return versions(b.owner_event_id, db)


@router.get("/{kind}/books/{book_id}/versions/{version_no}")
def book_version(kind: Kind, book_id: int, version_no: int, db: Session = Depends(session)):
    b = get_book(db, kind, book_id)
    return json.loads(version_row(db, owner(db, b), version_no).snapshot_json)


@router.get("/{kind}/books/{book_id}/changes")
def book_changes(kind: Kind, book_id: int, db: Session = Depends(session)):
    from .main import changes

    return changes(get_book(db, kind, book_id).owner_event_id, db)


def output_snapshot(db, b, version=None, draft=False, from_date="", to_date=""):
    from .main import detail, rows

    event = owner(db, b)
    if version or (event.latest_final_version and not draft):
        snap = json.loads(version_row(db, event, version).snapshot_json)
    elif draft:
        snap = detail(db, event)
        snap["annual"] = annual_snapshot(db, event)
        snap["receipts"] = [
            {**encode(r), "stored_path": r.stored_path} for r in rows(db, Receipt, event.id)
        ]
    else:
        raise HTTPException(422, "확정본이 없습니다. 초안 출력 옵션을 선택하세요.")
    if from_date and int(from_date[:4]) != b.year or to_date and int(to_date[:4]) != b.year:
        raise HTTPException(422, "조회 기간은 선택한 장부 연도 안에서 지정하세요.")
    if from_date and to_date and from_date > to_date:
        raise HTTPException(422, "조회 기간 순서를 확인하세요.")
    snap["annual"]["entries"] = [
        e
        for e in snap["annual"]["entries"]
        if (not from_date or (e["transaction_date"] or "") >= from_date)
        and (not to_date or (e["transaction_date"] or "") <= to_date)
    ]
    return snap


@router.get("/{kind}/books/{book_id}/excel/export")
def book_excel(
    kind: Kind,
    book_id: int,
    version: int | None = None,
    draft: bool = False,
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    db: Session = Depends(session),
):
    from .main import download

    b = get_book(db, kind, book_id)
    snap = output_snapshot(
        db,
        b,
        version,
        draft,
        from_date.isoformat() if from_date and kind == "b" else "",
        to_date.isoformat() if to_date and kind == "b" else "",
    )
    return download(
        export_book(snap),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        f'{"DRAFT_" if not snap.get("final_version") else ""}{LABEL[kind]}_{b.year}_장부.xlsx',
    )


@router.get("/ordinary/books/{book_id}/excel/export-church-ledger")
def church_ledger_excel(
    book_id: int,
    draft: bool = False,
    db: Session = Depends(session),
):
    from .main import download

    b = get_book(db, "ordinary", book_id)
    snap = output_snapshot(db, b, draft=draft)
    return download(
        export_church_ledger(snap),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        f'{"DRAFT_" if not snap.get("final_version") else ""}{b.year}_교회_장부.xlsx',
    )


@router.get("/{kind}/books/{book_id}/receipts/export-pptx")
def book_ppt(
    kind: Kind,
    book_id: int,
    version: int | None = None,
    draft: bool = False,
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    include_unverified: bool = False,
    per_slide: int = 3,
    db: Session = Depends(session),
):
    from .main import download

    b = get_book(db, kind, book_id)
    start = from_date.isoformat() if from_date else f"{b.year}-01-01"
    end = to_date.isoformat() if to_date else f"{b.year}-12-31"
    snap = output_snapshot(db, b, version, draft, start, end)
    return download(
        generate_ppt(snap, start, end, include_unverified, per_slide),
        MIME,
        f'{"DRAFT_" if not snap.get("final_version") else ""}{LABEL[kind]}_{b.year}_{start}_{end}_영수증증빙자료.pptx',
    )


@router.get("/{kind}/books/{book_id}/receipts/export-zip")
def book_zip(
    kind: Kind,
    book_id: int,
    version: int | None = None,
    draft: bool = False,
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    db: Session = Depends(session),
):
    from .main import download

    b = get_book(db, kind, book_id)
    start = from_date.isoformat() if from_date else f"{b.year}-01-01"
    end = to_date.isoformat() if to_date else f"{b.year}-12-31"
    snap = output_snapshot(db, b, version, draft, start, end)
    snap["receipts"] = select_receipts(snap, start, end, True)
    return download(
        receipt_archive(snap),
        "application/zip",
        f'{"DRAFT_" if not snap.get("final_version") else ""}{LABEL[kind]}_{b.year}_영수증.zip',
    )


@router.post("/{kind}/books/{book_id}/receipts/upload")
async def upload_receipts(
    kind: Kind,
    book_id: int,
    file: UploadFile = File(...),
    confirm_reuse: bool = Form(False),
    db: Session = Depends(session),
):
    from .main import receipt_upload

    b = get_book(db, kind, book_id)
    return await receipt_upload(b.owner_event_id, file, db, confirm_reuse)


@router.post("/{kind}/books/{book_id}/receipts/analyze", status_code=202)
def analyze_receipts(
    kind: Kind,
    book_id: int,
    background: BackgroundTasks,
    db: Session = Depends(session),
    data: ReceiptAnalysisIn | None = None,
):
    from .main import analyze

    b = get_book(db, kind, book_id)
    return analyze(b.owner_event_id, background, db, data)


@router.get("/{kind}/books/{book_id}/excel/import/template")
def annual_excel_template(
    kind: Kind,
    book_id: int,
    target: Literal["entries", "budget"] = "entries",
    db: Session = Depends(session),
):
    from .main import download
    from .excel_templates import sample_workbook, MIME

    b = get_book(db, kind, book_id)
    if kind == "b" and target == "budget":
        raise HTTPException(422, "B 장부에는 예산표가 없습니다.")
    data = sample_workbook(kind, b.year, target, budgets=budget_rows(db, b))
    label = "예산표" if target == "budget" else "장부"
    return download(data, MIME, f"{LABEL[kind]}_{b.year}_{label}_샘플.xlsx")


@router.post("/{kind}/books/{book_id}/excel/import/preview")
async def preview_excel(
    kind: Kind,
    book_id: int,
    file: UploadFile = File(...),
    target: Literal["entries", "budget"] = Form("entries"),
    mapping: str = Form("{}"),
    sheet_name: str = Form(""),
    db: Session = Depends(session),
):
    from .main import read_upload

    b = get_book(db, kind, book_id)
    e = ensure_editable(db, b)
    if target == "budget" and kind != "ordinary":
        raise HTTPException(422, "B에는 예산표가 없습니다.")
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(422, ".xlsx 파일만 지원합니다.")
    raw = await read_upload(file, 15 * 1024**2)
    try:
        result = parse_workbook(raw, b, target, json.loads(mapping), sheet_name)
    except Exception as exc:
        raise HTTPException(422, "Excel 파일의 형식·시트·열 매핑·용량을 확인하세요.") from exc
    result.update(version=e.version, book_id=b.id, kind=kind)
    if target == "entries":
        existing = {
            (x.transaction_date, x.description, x.income_krw, x.expense_krw) for x in entries(db, b)
        }
        leaves = [i for i in budget_rows(db, b) if i.level == 3 and i.is_active]
        allitems = {i.id: i for i in budget_rows(db, b)}
        for r in result["rows"]:
            if kind == "ordinary":
                candidates = [
                    i
                    for i in leaves
                    if i.name == r["budget_name"]
                    and allitems[i.parent_id].name == r["section"]
                    and (
                        not r.get("division")
                        or allitems[allitems[i.parent_id].parent_id].name == r["division"]
                    )
                ]
                if len(candidates) == 1:
                    r["budget_item_id"] = candidates[0].id
                else:
                    original = " / ".join(
                        r.get(k) or "(미입력)" for k in ["division", "section", "budget_name"]
                    )
                    r.update(
                        division="기타",
                        section="기타",
                        budget_name="기타",
                        temporary_classification=True,
                        review_status="검토 필요",
                        note=f"[임시 분류: 기타] Excel 원본 {r['source_row']}행 · 원본 관/항/목: {original}",
                    )
            if (
                r["transaction_date"],
                r["description"],
                r["income_krw"],
                r["expense_krw"],
            ) in existing:
                result["warnings"].append(f"{r['source_row']}행: 기존 거래 중복 후보")
    if target == "budget":
        official = {
            i["path"]: i["spent_krw"] for i in book_detail(db, b)["budget"] if i["level"] == 3
        }
        for row in result["rows"]:
            actual = official.get(f"{row['division']} / {row['section']} / {row['name']}", 0)
            imported = row.get("imported_spent_krw")
            if imported is not None and imported != actual:
                result["warnings"].append(
                    f"{row['source_row']}행: 파일 실지출 {imported:,}원과 확정 장부 {actual:,}원 차이. 파일 실지출은 반영하지 않습니다."
                )
    job = ImportJob(
        id=uuid.uuid4().hex,
        event_id=e.id,
        filename=file.filename,
        payload=json.dumps(result, ensure_ascii=False),
    )
    db.add(job)
    db.commit()
    return {**result, "job_id": job.id}


@router.post("/{kind}/books/{book_id}/excel/import/commit")
def commit_excel(kind: Kind, book_id: int, data: CommitIn, db: Session = Depends(session)):
    b = get_book(db, kind, book_id)
    event = ensure_editable(db, b)
    job = db.get(ImportJob, data.job_id)
    if not job or job.event_id != event.id or job.status != "preview":
        raise HTTPException(409, "다른 장부이거나 이미 반영한 미리보기입니다.")
    payload = json.loads(job.payload)
    if (
        payload.get("book_id") != b.id
        or payload.get("kind") != kind
        or payload["version"] != event.version
    ):
        raise HTTPException(409, "미리보기 이후 장부가 변경되었습니다. 다시 업로드하세요.")
    if payload["errors"] or payload["needs_mapping"] or not payload["rows"]:
        raise HTTPException(422, "오류를 수정한 후 다시 업로드하세요.")
    if payload["warnings"] and not data.accept_warnings:
        raise HTTPException(422, "경고를 먼저 확인하세요.")
    if data.mode == "replace" and not data.confirm_replace:
        raise HTTPException(422, "기존 데이터 대체 확인이 필요합니다.")
    audit(
        db,
        event.id,
        "import_backup",
        annual_snapshot(db, event),
        {"filename": job.filename, "mode": data.mode},
    )
    if payload["target"] == "budget":
        old = budget_rows(db, b)
        lookup = {(i.parent_id, i.name): i for i in old}
        items = (
            [
                BudgetIn(**{k: v for k, v in encode(i).items() if k in BudgetIn.model_fields})
                for i in old
            ]
            if data.mode == "append"
            else []
        )
        added = {i.id: i for i in items}
        temporary = -1
        for row in payload["rows"]:
            parent = None
            for level, name in [(1, row["division"]), (2, row["section"]), (3, row["name"])]:
                existing = lookup.get((parent, name))
                key = existing.id if existing else temporary
                if not existing:
                    temporary -= 1
                if key not in added:
                    obj = BudgetIn(
                        id=key,
                        parent_id=parent,
                        level=level,
                        name=name,
                        budget_krw=row["budget_krw"] if level == 3 else 0,
                        detail=row["detail"] if level == 3 else "",
                    )
                    items.append(obj)
                    added[key] = obj
                    lookup[parent, name] = type("Temp", (), {"id": key})()
                elif level == 3:
                    added[key].budget_krw = row["budget_krw"]
                    added[key].detail = row["detail"]
                parent = key
        apply_budget(db, b, BudgetSave(version=event.version, items=items))
    else:
        values = (
            [
                EntryIn(**{k: v for k, v in encode(x).items() if k in EntryIn.model_fields})
                for x in entries(db, b)
            ]
            if data.mode == "append"
            else []
        )
        if kind == "ordinary" and any(r.get("temporary_classification") for r in payload["rows"]):
            fallback = ensure_other_budget_item(db, b, event)
            for row in payload["rows"]:
                if row.get("temporary_classification"):
                    row["budget_item_id"] = fallback.id
        values.extend(
            EntryIn(**{k: v for k, v in r.items() if k in EntryIn.model_fields})
            for r in payload["rows"]
        )
        apply_entries(db, b, EntrySave(version=event.version, entries=values), source="excel")
    job.status = "committed"
    db.commit()
    return {"imported_count": len(payload["rows"]), "book": book_detail(db, b)}
