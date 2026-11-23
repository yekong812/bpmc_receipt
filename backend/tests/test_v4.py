import io
import json
import zipfile
from PIL import Image
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.util import Inches, Pt
from openpyxl import load_workbook
from backend.tests.test_system import client, create, add, upload, confirm_receipt, image_zip


def book(c, kind="ordinary", year=2026, **extra):
    r = c.post(f"/api/{kind}/books", json={"year": year, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def detail(c, b):
    return c.get(f"/api/{b['kind']}/books/{b['id']}").json()


def budget(c, b, amount=10000):
    values = [
        {"id": -1, "parent_id": None, "level": 1, "name": "공동체", "budget_krw": 0},
        {"id": -2, "parent_id": -1, "level": 2, "name": "운영비", "budget_krw": 0},
        {"id": -3, "parent_id": -2, "level": 3, "name": "팀장운영", "budget_krw": amount},
    ]
    r = c.put(
        f"/api/ordinary/books/{b['id']}/budget",
        json={"version": detail(c, b)["version"], "items": values},
    )
    assert r.status_code == 200, r.text
    return r.json()


def entry(c, b, **patch):
    values = {
        "transaction_date": f"{b['year']}-01-10",
        "description": "간식",
        "income_krw": 0,
        "expense_krw": 5000,
        "entry_type": "expense",
        "review_status": "확인됨",
        "note": "현금 구매",
    }
    if b["kind"] == "ordinary":
        values["budget_item_id"] = next(i["id"] for i in detail(c, b)["budget"] if i["level"] == 3)
    values.update(patch)
    r = c.post(f"/api/{b['kind']}/books/{b['id']}/entries", json=values)
    assert r.status_code == 201, r.text
    return r.json()


def finalize(c, b):
    prefix = f"/api/{b['kind']}/books/{b['id']}"
    d = detail(c, b)
    r = c.post(
        prefix + "/finalize",
        json={
            "version": d["version"],
            "acknowledge_warnings": True,
            "approval_reason": "담당자 확인 완료",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


def import_preview(c, b, data, target="entries"):
    r = c.post(
        f"/api/{b['kind']}/books/{b['id']}/excel/import/preview",
        files={"file": ("test.xlsx", data)},
        data={"target": target},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_book_year_kind_isolation_and_unique_year(client):
    c = client
    a = book(c)
    b = book(c, year=2027)
    cash = book(c, "b")
    assert c.get("/api/events").json() == []
    assert c.post("/api/ordinary/books", json={"year": 2026}).status_code == 409
    a = budget(c, a)
    entry(c, a)
    assert detail(c, b)["entries"] == [] and detail(c, cash)["entries"] == []
    assert detail(c, a)["draft_totals"]["expense_krw"] == 5000
    bad = c.post(
        f"/api/ordinary/books/{a['id']}/entries",
        json={"transaction_date": "2027-01-01", "description": "다른 해", "expense_krw": 1000},
    )
    assert bad.status_code == 422
    assert c.get(f"/api/b/books/{a['id']}").status_code == 404


def test_expenses_and_annual_entries_default_to_date_order(client):
    event = create(client)
    annual = book(client, "b")
    dates = ["2026-11-12", None, "2026-11-08", "2026-11-08"]
    expected = ["거래 2", "거래 3", "거래 0", "거래 1"]
    for i, day in enumerate(dates):
        name = f"거래 {i}"
        add(client, event, expense_date=day, item_name=name)
        entry(client, annual, transaction_date=day, description=name)

    event_detail = client.get(f"/api/events/{event['id']}").json()
    assert [x["item_name"] for x in event_detail["expenses"]] == expected
    annual_detail = detail(client, annual)
    assert [x["description"] for x in annual_detail["entries"]] == expected
    assert [x["item_name"] for x in annual_detail["owner"]["expenses"]] == expected


def test_receipt_drafts_reuse_other_budget_and_keep_unknown_fields_empty(client, monkeypatch):
    from backend.app import main

    monkeypatch.setattr(main, "recognize", lambda _: "")
    annual = book(client)
    owner = {"id": annual["owner_event_id"]}
    images = []
    for color in ("red", "blue"):
        raw = io.BytesIO()
        Image.new("RGB", (30, 40), color).save(raw, format="PNG")
        images.append((f"{color}.png", raw.getvalue()))
    upload(client, owner, image_zip(images))
    response = client.post(f"/api/ordinary/books/{annual['id']}/receipts/analyze")
    assert response.status_code == 202, response.text
    result = detail(client, annual)
    leaf = next(item for item in result["budget"] if item["level"] == 3)
    assert len(result["budget"]) == 3 and leaf["path"] == "기타 / 기타 / 기타"
    assert len(result["entries"]) == len(result["owner"]["links"]) == 2
    for entry in result["entries"]:
        assert entry["budget_item_id"] == leaf["id"] and entry["description"] == ""
        assert entry["expense_krw"] is None and entry["review_status"] == "검토 필요"


def test_receipt_draft_uses_earliest_time_across_analysis_jobs(client, monkeypatch):
    from backend.app import main

    results = {
        (255, 0, 0): "늦은 거래\n2026-11-08 15:00\n합계 5,000원",
        (0, 0, 255): "이른 거래\n2026-11-08 09:00\n합계 5,000원",
        (0, 128, 0): "시간 미확인\n2026-11-08\n합계 5,000원",
        (255, 255, 0): "다른 거래\n2026-11-09 09:00\n합계 5,000원",
    }

    def recognize(path):
        with Image.open(path) as image:
            return results[image.getpixel((0, 0))]

    monkeypatch.setattr(main, "recognize", recognize)
    annual = book(client)
    owner = {"id": annual["owner_event_id"]}
    analyze = f"/api/events/{owner['id']}/receipts/analyze"
    for name, colors in (("first", ["red"]), ("second", ["blue", "green", "yellow"])):
        files = []
        for color in colors:
            raw = io.BytesIO()
            Image.new("RGB", (30, 40), color).save(raw, format="PNG")
            files.append((f"{color}.png", raw.getvalue()))
        upload(client, owner, image_zip(files))
        job = client.post(analyze)
        assert job.status_code == 202, job.text
        result = detail(client, annual)
        if name == "first":
            first_entry = result["entries"][0]["id"]

    entries = result["entries"]
    assert [x["transaction_date"] for x in entries] == ["2026-11-08", "2026-11-09"]
    assert entries[0]["id"] == first_entry
    assert entries[0]["description"].startswith("이른 거래")
    linked = {x["receipt_id"] for x in result["owner"]["links"]}
    assert len(result["owner"]["receipts"]) == 4
    assert {
        r["original_name"] for r in result["owner"]["receipts"] if r["id"] in linked
    } == {"blue.png", "yellow.png"}


def test_budget_constraints_official_spending_and_revision(client):
    c = client
    b = budget(c, book(c))
    other = budget(c, book(c, year=2027))
    leaf = next(i for i in b["budget"] if i["level"] == 3)
    invalid = c.post(
        f"/api/ordinary/books/{b['id']}/entries",
        json={
            "transaction_date": "2026-01-01",
            "description": "잘못된 목",
            "expense_krw": 1000,
            "budget_item_id": other["budget"][-1]["id"],
        },
    )
    assert invalid.status_code == 422
    assert (
        c.post(
            f"/api/ordinary/books/{b['id']}/entries",
            json={"description": "양쪽금액", "income_krw": 1, "expense_krw": 1},
        ).status_code
        == 422
    )
    x = entry(c, b)
    d = detail(c, b)
    assert d["totals"]["expense_krw"] == 0 and d["draft_totals"]["expense_krw"] == 5000
    final = finalize(c, b)
    item = next(i for i in final["budget"] if i["id"] == leaf["id"])
    assert item["spent_krw"] == 5000 and item["remaining_krw"] == 5000 and item["ratio"] == 50
    assert (
        c.patch(f"/api/ordinary/entries/{x['id']}", json={**x, "expense_krw": 7500}).status_code
        == 409
    )
    assert (
        c.post(
            f"/api/ordinary/books/{b['id']}/reopen", json={"version": final["version"]}
        ).status_code
        == 200
    )
    assert (
        c.patch(f"/api/ordinary/entries/{x['id']}", json={**x, "expense_krw": 7500}).status_code
        == 200
    )
    d = detail(c, b)
    assert d["totals"]["expense_krw"] == 5000 and d["draft_totals"]["expense_krw"] == 7500
    keep = [
        {
            k: v
            for k, v in i.items()
            if k
            in [
                "id",
                "parent_id",
                "level",
                "name",
                "budget_krw",
                "detail",
                "sort_order",
                "is_active",
            ]
        }
        for i in d["budget"]
        if i["id"] != leaf["id"]
    ]
    assert (
        c.put(
            f"/api/ordinary/books/{b['id']}/budget", json={"version": d["version"], "items": keep}
        ).status_code
        == 409
    )
    refinal = c.post(
        f"/api/ordinary/books/{b['id']}/finalize",
        json={
            "version": d["version"],
            "acknowledge_warnings": True,
            "approval_reason": "정정 확인",
        },
    )
    assert refinal.status_code == 200, refinal.text
    assert (
        c.get(f"/api/ordinary/books/{b['id']}/versions/1").json()["annual"]["entries"][0][
            "expense_krw"
        ]
        == 5000
    )


def test_budget_copy_and_b_carryover_totals(client):
    c = client
    b = budget(c, book(c))
    entry(c, b)
    copied = book(c, year=2027, copy_budget_from=b["id"])
    assert copied["total_budget_krw"] == 10000 and copied["entries"] == []
    assert copied["budget"][-1]["id"] != b["budget"][-1]["id"]
    from backend.app.annual_schemas import BudgetIn
    updated=[{k:v for k,v in item.items() if k in BudgetIn.model_fields} for item in copied['budget']]
    next(item for item in updated if item['level']==3)['budget_krw']=20000
    result=c.put(f"/api/ordinary/books/{copied['id']}/budget",json={'version':copied['version'],'items':updated})
    assert result.status_code==200,result.text
    assert detail(c,b)['total_budget_krw']==10000
    logs=c.get(f"/api/ordinary/books/{copied['id']}/changes").json()
    log=next(log for log in logs if log['field_name']=='budget')
    assert next(item for item in json.loads(log['old_value']) if item['level']==3)['budget_krw']==10000
    assert next(item for item in json.loads(log['new_value']) if item['level']==3)['budget_krw']==20000
    cash = book(c, "b")
    entry(c, cash, income_krw=1000, expense_krw=0, entry_type="carryover", description="전기 잔액")
    entry(c, cash, income_krw=10000, expense_krw=0, entry_type="income")
    entry(c, cash)
    d = finalize(c, cash)
    assert (
        d["totals"]["income_krw"] == 11000
        and d["totals"]["expense_krw"] == 5000
        and d["totals"]["balance_krw"] == 6000
        and d["totals"]["carryover_krw"] == 1000
        and d["totals"]["income_excluding_carryover_krw"] == 10000
    )
    assert c.get(f"/api/b/books/{cash['id']}/budget").status_code == 404


def test_church_ledger_exports_monthly_balances_and_receipt_numbers(client):
    b = budget(client, book(client))
    prefix = f"/api/ordinary/books/{b['id']}/excel/export-church-ledger"
    assert client.get(prefix + "?draft=true").status_code == 422
    entry(
        client,
        b,
        transaction_date="2026-01-01",
        entry_type="carryover",
        income_krw=100000,
        expense_krw=0,
        description="전기 이월",
    )
    entry(
        client,
        b,
        transaction_date="2026-01-01",
        entry_type="income",
        income_krw=2000000,
        expense_krw=0,
        description="1월 경상비",
    )
    expense = entry(client, b, transaction_date="2026-01-03", expense_krw=1083930)
    owner = {"id": b["owner_event_id"]}
    receipt = confirm_receipt(client, upload(client, owner), 1083930, "2026-01-03T09:00:00")
    link = client.post(
        f"/api/events/{owner['id']}/receipt-links",
        json={
            "expense_id": expense["expense_id"],
            "receipt_id": receipt["id"],
            "allocated_amount_krw": 1083930,
        },
    )
    assert link.status_code == 200, link.text
    entry(
        client,
        b,
        transaction_date="2026-03-01",
        entry_type="carryover",
        income_krw=1016070,
        expense_krw=0,
        description="전월 이월",
    )
    entry(client, b, transaction_date="2026-03-02", expense_krw=16070)
    entry(client, b, transaction_date=None, expense_krw=1000)

    result = client.get(prefix + "?draft=true")
    assert result.status_code == 200, result.text
    workbook = load_workbook(io.BytesIO(result.content), data_only=True)
    assert workbook.sheetnames == ["청년부(1월)", "청년부(2월)", "청년부(3월)", "날짜 미확인"]
    jan, feb, mar, unknown = (workbook[name] for name in workbook.sheetnames)
    assert jan["D3"].value == "부서 : 청년부" and jan["D4"].value == "2026년 1월"
    assert jan["E7"].value == 100000 and jan["E24"].value == 2000000
    assert jan["F24"].value == 1083930 and jan["E25"].value == 1016070
    assert jan["G9"].value == str(receipt["receipt_number"])
    assert jan["B24"].fill.fgColor.rgb.endswith("F4CCCC") and jan["B26"].value == "결재"
    assert feb["E7"].value == feb["E25"].value == mar["E7"].value == 1016070
    assert mar["E24"].value == 0 and mar["F24"].value == 16070 and mar["E25"].value == 1000000
    assert unknown["F8"].value == 1000 and unknown["E25"].value is None


def test_annual_excel_roundtrip_and_wrong_year(client):
    c = client
    b = budget(c, book(c))
    entry(c, b)
    url = f"/api/ordinary/books/{b['id']}"
    raw = c.get(url + "/excel/export?draft=true")
    assert raw.status_code == 200
    wb = load_workbook(io.BytesIO(raw.content))
    assert wb.sheetnames[:2] == ["예산 현황", "경상비 장부"]
    ledger = wb["경상비 장부"]
    assert ledger["A3"].alignment.horizontal == ledger["A4"].alignment.horizontal == "center"
    assert ledger["D4"].alignment.horizontal == "left" and ledger["D4"].alignment.wrap_text
    assert ledger["F4"].alignment.horizontal == "right" and "₩" in ledger["F4"].number_format
    assert ledger["D4"].border.right.style == ledger["D4"].border.bottom.style == "thin"
    assert ledger["F5"].value == 5000 and ledger["F5"].font.bold
    assert ledger["F5"].border.top.style == "medium"
    budget_sheet = wb["예산 현황"]
    assert budget_sheet["H4"].number_format == "0.0%"
    assert budget_sheet["D5"].fill != budget_sheet["D6"].fill
    assert budget_sheet["D6"].value == 10000 and budget_sheet["D6"].font.bold
    p = import_preview(c, b, raw.content)
    assert len(p["rows"]) == 1 and not p["errors"] and p["warnings"]
    result = c.post(
        url + "/excel/import/commit",
        json={
            "job_id": p["job_id"],
            "mode": "replace",
            "confirm_replace": True,
            "accept_warnings": True,
        },
    )
    assert result.status_code == 200, result.text
    assert detail(c, b)["draft_totals"]["expense_krw"] == 5000
    other = book(c, year=2027, copy_budget_from=b["id"])
    wrong = import_preview(c, other, raw.content)
    assert wrong["errors"]
    p = import_preview(c, b, raw.content, "budget")
    assert not p["errors"] and len(p["rows"]) == 1
    result = c.post(
        url + "/excel/import/commit", json={"job_id": p["job_id"], "accept_warnings": True}
    )
    assert result.status_code == 200, result.text
    cash = book(c, "b")
    entry(c, cash, income_krw=12000, expense_krw=0, entry_type="carryover", description="전기 잔액")
    data = c.get(f"/api/b/books/{cash['id']}/excel/export?draft=true").content
    b_sheet = load_workbook(io.BytesIO(data))["B 장부"]
    assert b_sheet["C5"].value == 12000 and b_sheet["C5"].border.top.style == "medium"
    assert b_sheet.column_dimensions["G"].hidden
    p = import_preview(c, cash, data)
    assert p["rows"][0]["entry_type"] == "carryover"


def twenty_images():
    files = []
    for i in range(20):
        raw = io.BytesIO()
        Image.new("RGB", (100 + i, 250), (i, 80, 120)).save(raw, format="PNG")
        files.append((f"{i:02d}.png", raw.getvalue()))
    return image_zip(files)


def test_ppt_twenty_receipts_seven_slides_no_cropping_and_stable_numbers(client):
    c = client
    e = create(c)
    res = c.post(
        f"/api/events/{e['id']}/receipts/upload", files={"file": ("20.zip", twenty_images())}
    )
    assert res.status_code == 200, res.text
    rs = c.get(f"/api/events/{e['id']}/receipts").json()
    for i, r in enumerate(rs):
        confirm_receipt(c, r, 1000 + i, f"2026-11-08T09:{19-i:02d}:00")
    out = c.get(f"/api/events/{e['id']}/receipts/export-pptx?draft=true")
    assert out.status_code == 200, out.text
    prs = Presentation(io.BytesIO(out.content))
    assert len(prs.slides) == 7 and abs(prs.slide_width / prs.slide_height - 16 / 9) < 0.001
    for i, slide in enumerate(prs.slides):
        pictures = [s for s in slide.shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE]
        assert len(pictures) == (2 if i == 6 else 3)
        for p in pictures:
            assert p.crop_top == 0 and p.crop_bottom == 0 and p.crop_left == 0 and p.crop_right == 0
            assert abs(p.width / p.height - p.image.size[0] / p.image.size[1]) < 0.001
            assert p.height >= Inches(6)
            assert p.top + p.height <= Inches(6.75)
        for shape in slide.shapes:
            if shape.has_text_frame:
                assert all(p.font.size <= Pt(13) for p in shape.text_frame.paragraphs)
    text = " ".join(s.text for s in prs.slides[0].shapes if s.has_text_frame)
    assert "영수증 #20" in text and "미확정 초안" in text
    captions = " ".join(s.text for s in prs.slides[-1].shapes if s.has_text_frame)
    assert "영수증 #1" in captions


def test_event_receipt_exports_can_filter_by_date(client):
    event = create(client)
    endpoint = f"/api/events/{event['id']}/receipts"
    images = []
    for color in ("red", "blue"):
        raw = io.BytesIO()
        Image.new("RGB", (30, 40), color).save(raw, format="PNG")
        images.append((f"{color}.png", raw.getvalue()))
    upload(client, event, image_zip(images))
    for receipt, day in zip(client.get(endpoint).json(), ("08", "09")):
        confirm_receipt(client, receipt, 5000, f"2026-11-{day}T09:00:00")
    query = "?draft=true&from=2026-11-09&to=2026-11-09"
    ppt = client.get(endpoint + "/export-pptx" + query)
    assert ppt.status_code == 200, ppt.text
    slide = Presentation(io.BytesIO(ppt.content)).slides[0]
    assert sum(s.shape_type == MSO_SHAPE_TYPE.PICTURE for s in slide.shapes) == 1
    assert any("2026-11-09 09:00" in s.text for s in slide.shapes if s.has_text_frame)
    archive = client.get(endpoint + "/export-zip" + query)
    assert archive.status_code == 200, archive.text
    with zipfile.ZipFile(io.BytesIO(archive.content)) as output:
        assert output.namelist() == ["receipts/1_5000.png", "receipts_summary.csv"]
        assert "red.png" in output.read("receipts_summary.csv").decode("utf-8-sig")


def test_ppt_unverified_and_corrupt_file_errors(client):
    from backend.app.db import STORAGE
    from backend.app.models import Receipt
    from backend.app.db import SessionLocal

    c = client
    e = create(c)
    r = upload(c, e)
    assert c.get(f"/api/events/{e['id']}/receipts/export-pptx?draft=true").status_code == 422
    assert (
        c.get(
            f"/api/events/{e['id']}/receipts/export-pptx?draft=true&include_unverified=true"
        ).status_code
        == 200
    )
    with SessionLocal() as db:
        path = STORAGE / db.get(Receipt, r["id"]).stored_path
    path.write_bytes(b"broken")
    assert (
        c.get(
            f"/api/events/{e['id']}/receipts/export-pptx?draft=true&include_unverified=true"
        ).status_code
        == 409
    )


def test_annual_period_exports_and_cross_scope_reuse_confirmation(client):
    c = client
    b = book(c, "b")
    prefix = f"/api/b/books/{b['id']}"
    image = io.BytesIO()
    Image.new("RGB", (50, 100), "white").save(image, format="PNG")
    out = c.post(
        prefix + "/receipts/upload", files={"file": ("receipt.png", image.getvalue(), "image/png")}
    )
    assert out.status_code == 200, out.text
    r = c.get(f"/api/events/{b['owner_event_id']}/receipts").json()[0]
    confirm_receipt(c, r, 5000, "2026-01-02T09:00:00")
    assert (
        c.get(prefix + "/receipts/export-pptx?draft=true&from=2026-02-01&to=2026-02-28").status_code
        == 422
    )
    out = c.get(prefix + "/receipts/export-pptx?draft=true&from=2026-01-01&to=2026-01-31")
    assert out.status_code == 200
    assert len(Presentation(io.BytesIO(out.content)).slides) == 1
    assert c.get(prefix + "/receipts/export-pptx?draft=true&from=2027-01-01").status_code == 422
    other = book(c, year=2027)
    target = f"/api/ordinary/books/{other['id']}/receipts/upload"
    assert (
        c.post(target, files={"file": ("receipt.png", image.getvalue(), "image/png")}).status_code
        == 409
    )
    assert (
        c.post(
            target,
            files={"file": ("receipt.png", image.getvalue(), "image/png")},
            data={"confirm_reuse": "true"},
        ).status_code
        == 200
    )
    duplicate = c.get(f"/api/events/{other['owner_event_id']}/receipts").json()[0]
    assert duplicate["ocr_status"] == "제외"
    assert f"{b['name']}의 영수증 #{r['receipt_number']}" in duplicate["review_reason"]


def test_ai_budget_classification_and_job_usage(client, monkeypatch):
    import httpx
    import backend.app.main as main
    from backend.app.llm_service import extract_receipt
    from backend.tests.test_llm import response, FIELDS

    c = client
    b = budget(c, book(c))
    leaf = next(i for i in b["budget"] if i["level"] == 3)
    monkeypatch.setenv("RECEIPT_LLM_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-key")
    monkeypatch.setenv("RECEIPT_LLM_MODE", "vision")
    monkeypatch.setenv("RECEIPT_LLM_ALLOW_IMAGES", "true")
    monkeypatch.setenv("OPENAI_INPUT_USD_PER_MILLION", "1")
    monkeypatch.setenv("OPENAI_OUTPUT_USD_PER_MILLION", "2")
    seen = []

    def handle(request):
        payload = json.loads(request.content)
        seen.append(payload)
        assert "공동체 / 운영비 / 팀장운영" in payload["input"][0]["content"][0]["text"]
        return httpx.Response(
            200,
            json=response(
                {
                    **FIELDS,
                    "suggested_category_id": leaf["category_id"],
                    "suggested_budget_item_id": leaf["id"],
                    "transaction_date": "2026-01-10",
                }
            ),
        )

    monkeypatch.setattr(
        main,
        "extract_receipt",
        lambda *args: extract_receipt(*args, transport=httpx.MockTransport(handle)),
    )
    raw = io.BytesIO()
    Image.new("RGB", (40, 80), "white").save(raw, format="PNG")
    assert (
        c.post(
            "/api/receipts/upload",
            data={"scope_type": "ordinary", "scope_id": b["id"]},
            files={"file": ("one.png", raw.getvalue(), "image/png")},
        ).status_code
        == 200
    )
    job = c.post("/api/analysis-jobs", json={"scope_type": "ordinary", "scope_id": b["id"]})
    assert job.status_code == 202, job.text
    result = detail(c, b)
    assert (
        len(result["entries"]) == 1
        and result["entries"][0]["budget_item_id"] == leaf["id"]
        and result["entries"][0]["expense_krw"] == 7500
    )
    status = c.get(f"/api/analysis-jobs/{job.json()['id']}").json()
    assert (
        status["input_tokens"] == 100
        and status["output_tokens"] == 40
        and status["estimated_cost_usd"] == "0.00018"
    )
    assert len(seen) == 1


def test_llm_rejects_out_of_scope_category_and_classifies_clean_ocr():
    import httpx
    from backend.app.llm_service import extract_receipt
    from backend.tests.test_llm import response, FIELDS, CFG
    from backend.app.receipts import parse_receipt

    text = "상점\n2026-11-08 09:15\n합계 7,500원"
    rules = parse_receipt(text)
    transport = httpx.MockTransport(
        lambda _: httpx.Response(
            200, json=response({**FIELDS, "suggested_category_id": 99, "final_amount_krw": 9999})
        )
    )
    result = extract_receipt(
        "unused",
        text,
        rules,
        [{"id": 1, "name": "환대", "budget_item_id": None}],
        settings=CFG,
        transport=transport,
    )
    assert result.attempted and result.candidate["suggested_category_id"] is None
    assert (
        result.candidate["final_amount_krw"] == 7500
        and "목록 밖" in result.candidate["review_reason"]
    )


def test_ppt_old_snapshot_uses_archived_bytes_and_receipt_number(client):
    c = client
    e = create(c)
    x = add(c, e)
    r = confirm_receipt(c, upload(c, e))
    c.post(
        f"/api/events/{e['id']}/receipt-links",
        json={"expense_id": x["id"], "receipt_id": r["id"], "allocated_amount_krw": 5000},
    )
    current = c.get(f"/api/events/{e['id']}").json()
    c.post(f"/api/events/{e['id']}/review", json={"version": current["version"]})
    current = c.get(f"/api/events/{e['id']}").json()
    final = c.post(f"/api/events/{e['id']}/finalize", json={"version": current["version"]})
    assert final.status_code == 200
    assert (
        c.post(
            f"/api/events/{e['id']}/reopen", json={"version": final.json()["version"]}
        ).status_code
        == 200
    )
    assert c.delete(f"/api/receipts/{r['id']}").status_code == 204
    replacement = upload(c, e)
    assert replacement["receipt_number"] == 2
    out = c.get(f"/api/events/{e['id']}/receipts/export-pptx?version=1")
    assert out.status_code == 200, out.text
    prs = Presentation(io.BytesIO(out.content))
    text = " ".join(s.text for s in prs.slides[0].shapes if s.has_text_frame)
    assert "영수증 #1" in text and "5,000" in text


def test_v3_migration_keeps_records_and_creates_backup(tmp_path):
    import os, subprocess, sys

    root = __import__("pathlib").Path(__file__).resolve().parents[2]
    script = """
from alembic import command
from alembic.config import Config
from backend.app.db import engine
from sqlalchemy import text
command.upgrade(Config('backend/alembic.ini'),'0003')
with engine.begin() as db:
 db.execute(text(\"INSERT INTO events (id,name,start_date,end_date,status,created_at,updated_at,version,event_date,latest_final_version) VALUES (1,'보존 검증','2026-01-01','2026-12-31','작성중','','',1,'2026-12-31',0)\"))
 db.execute(text(\"INSERT INTO event_categories (id,event_id,name,color,sort_order,is_active) VALUES (1,1,'기존 항목','#e5e7eb',0,1)\"))
 db.execute(text(\"INSERT INTO expenses (id,event_id,category_id,expense_date,item_name,amount_krw,vendor,purchased,sort_order,note,source_type,review_status,edited_by,edited_at) VALUES (1,1,1,'2026-01-01','기존 지출',1000,'',0,0,'','manual','확인됨','local-user','')\"))
 db.execute(text(\"INSERT INTO receipts (id,event_id,original_name,stored_path,transaction_at,merchant,description,final_amount_krw,ocr_status,review_reason,sha256,ocr_text) VALUES (1,1,'old.png','old.png','2026-01-01T09:00:00','기존 상점','지출',1000,'확인됨','','hash','원문')\"))
 db.execute(text(\"INSERT INTO expense_receipts VALUES (1,1,1000)\"))
from fastapi.testclient import TestClient
from backend.app.main import app
with TestClient(app) as c:
 data=c.get('/api/events/1').json()
 assert data['name']=='보존 검증' and data['expenses'][0]['amount_krw']==1000
 assert data['receipts'][0]['receipt_number']==1 and len(data['links'])==1
"""
    env = {
        **os.environ,
        "STORAGE_DIR": str(tmp_path),
        "DATABASE_URL": f"sqlite:///{tmp_path}/migration.db",
        "RECEIPT_LLM_ENABLED": "false",
    }
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert list((tmp_path / "backups").glob("*before_0003_to_0005.sqlite3"))


def test_intermediate_v4_job_column_repaired_without_losing_data(tmp_path):
    import os, subprocess, sys

    root = __import__("pathlib").Path(__file__).resolve().parents[2]
    script = """
from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from backend.app.db import engine
from sqlalchemy import inspect
command.upgrade(Config('backend/alembic.ini'),'0004')
with engine.begin() as db:
 op=Operations(MigrationContext.configure(db))
 with op.batch_alter_table('receipt_extractions') as b:
  b.drop_constraint('fk_extractions_processing_job',type_='foreignkey')
  b.drop_column('processing_job_id')
from fastapi.testclient import TestClient
from backend.app.main import app
with TestClient(app) as c:assert c.get('/api/health').status_code==200
assert 'processing_job_id' in {c['name'] for c in inspect(engine).get_columns('receipt_extractions')}
"""
    env = {
        **os.environ,
        "STORAGE_DIR": str(tmp_path),
        "DATABASE_URL": f"sqlite:///{tmp_path}/repair.db",
        "RECEIPT_LLM_ENABLED": "false",
    }
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert list((tmp_path / "backups").glob("*before_0004_to_0005.sqlite3"))
