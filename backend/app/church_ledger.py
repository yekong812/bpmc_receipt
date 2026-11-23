"""Monthly printable workbook for ordinary church expenses."""

import io
from collections import defaultdict
from datetime import date
from math import ceil
from unicodedata import east_asian_width

from fastapi import HTTPException
from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

DEPARTMENT = "청년부"
MONEY = '"₩"#,##0;-"₩"#,##0'
HEADERS = ("No.", "거래일시", "지출내용", "입금", "출금", "번호(월-번호)")


def monthly_sheet(ws, title, entries, receipt_refs, opening=None, recorded_carry=None):
    last_transaction = 7 + max(16, len(entries) + 2)
    subtotal = last_transaction + 1
    balance = subtotal + 1
    approval = balance + 1
    edge = Side(style="medium", color="000000")
    line = Side(style="thin", color="000000")
    pink = PatternFill("solid", fgColor="F4CCCC")
    gray = PatternFill("solid", fgColor="EFEFEF")

    ws["D3"] = f"부서 : {DEPARTMENT}"
    ws["D4"] = title
    ws["B7"] = "이월금" if opening is not None else None
    ws["E7"] = opening
    if recorded_carry is not None and recorded_carry != opening:
        ws["E7"].comment = Comment(
            f"장부에 입력된 이월금은 {recorded_carry:,}원입니다. 이 양식에는 전월 잔액을 적용했습니다.",
            "교회 장부",
        )
    for col, header in enumerate(HEADERS, 2):
        ws.cell(6, col, header)
    for number, entry in enumerate(entries, 1):
        day = entry["transaction_date"]
        values = (
            number,
            date.fromisoformat(day) if day else None,
            entry["description"],
            entry["income_krw"] or None,
            entry["expense_krw"] or None,
            ", ".join(receipt_refs.get(entry["expense_id"], [])),
        )
        for col, value in enumerate(values, 2):
            cell = ws.cell(number + 7, col, value)
            if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
                cell.data_type = "s"
        ws.cell(number + 7, 3).number_format = "m.d"
    income = sum(entry["income_krw"] or 0 for entry in entries)
    expenses = sum(entry["expense_krw"] or 0 for entry in entries)
    closing = opening + income - expenses if opening is not None else None
    ws.cell(subtotal, 2, "월 계" if opening is not None else "미확인 합계")
    ws.cell(subtotal, 5, income)
    ws.cell(subtotal, 6, expenses)
    ws.cell(balance, 2, "잔 액")
    ws.cell(balance, 5, closing)
    ws.cell(approval, 2, "결재")
    for col, label in enumerate(("총무/부장", "교역자", "재무부"), 5):
        ws.cell(approval, col, label)

    for col, width in zip("ABCDEFG", (3, 6, 13, 33, 19, 19, 18)):
        ws.column_dimensions[col].width = width
    for row in range(2, approval + 2):
        description = ws.cell(row, 4).value if 8 <= row <= last_transaction else None
        lines = sum(
            max(1, ceil(sum(2 if east_asian_width(c) in ("W", "F") else 1 for c in line) / 30))
            for line in (description or "").split("\n")
        )
        ws.row_dimensions[row].height = min(408, 21 + 13 * (lines - 1))
        for col in range(2, 8):
            cell = ws.cell(row, col)
            money_cell = col in (5, 6) and 7 <= row <= balance
            highlighted = row in (subtotal, balance) and col <= 6
            cell.alignment = Alignment(
                horizontal="right" if money_cell else "center",
                vertical="center",
                wrap_text=True,
                indent=1 if money_cell else 0,
            )
            cell.font = Font(
                name="맑은 고딕",
                size=10,
                color="C00000" if highlighted or row == 7 and col in (2, 5) else "000000",
                bold=row in (6, 7, subtotal, balance, approval) or col == 2,
            )
            cell.border = Border(
                left=edge if col == 2 else line if row >= 6 else None,
                right=edge if col == 7 else line if row >= 6 else None,
                top=edge if row in (2, subtotal, balance, approval) else line if row >= 6 else None,
                bottom=(
                    edge
                    if row in (subtotal, balance, approval + 1)
                    else line if row >= 6 or row == 4 and 4 <= col <= 6 else None
                ),
            )
            if money_cell:
                cell.number_format = MONEY
            if highlighted:
                cell.fill = pink
            elif row == 6 or row == 3 and 4 <= col <= 6:
                cell.fill = gray
    ws["D3"].alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws["D3"].font = Font(name="맑은 고딕", size=12, bold=True)
    ws["D4"].font = Font(name="맑은 고딕", size=13, bold=True)
    ws.row_dimensions[4].height = 24
    ws.row_dimensions[subtotal].height = ws.row_dimensions[balance].height = 24
    ws.row_dimensions[approval + 1].height = 36
    for r, start, end in (
        (3, 4, 6),
        (4, 4, 6),
        (7, 2, 3),
        (subtotal, 2, 4),
        (balance, 2, 4),
        (balance, 5, 6),
    ):
        ws.merge_cells(start_row=r, start_column=start, end_row=r, end_column=end)
    ws.merge_cells(start_row=approval, start_column=2, end_row=approval + 1, end_column=4)
    ws.freeze_panes = "B8"
    ws.sheet_view.showGridLines = False
    ws.print_area = f"B2:G{approval + 1}"
    ws.print_title_rows = "2:6"
    ws.page_setup.orientation = "portrait"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_options.horizontalCentered = True
    return closing


def export_church_ledger(snapshot):
    annual = snapshot["annual"]
    year = annual["book"]["year"]
    entries = annual["entries"]
    if not entries:
        raise HTTPException(422, "교회 장부에 출력할 거래가 없습니다.")
    months = defaultdict(list)
    undated = []
    for entry in entries:
        if entry["transaction_date"]:
            months[date.fromisoformat(entry["transaction_date"]).month].append(entry)
        else:
            undated.append(entry)
    receipt_numbers = {
        receipt["id"]: str(receipt.get("receipt_number") or i)
        for i, receipt in enumerate(snapshot["receipts"], 1)
        if receipt["ocr_status"] != "제외"
    }
    receipt_refs = defaultdict(list)
    for link in snapshot["links"]:
        if link["receipt_id"] in receipt_numbers:
            receipt_refs[link["expense_id"]].append(receipt_numbers[link["receipt_id"]])

    wb = Workbook()
    wb.remove(wb.active)
    if months:
        first, last = min(months), max(months)
        opening = 0
        for month in range(first, last + 1):
            month_entries = months[month]
            explicit = [
                e["income_krw"] or 0 for e in month_entries if e["entry_type"] == "carryover"
            ]
            if month == first:
                opening = sum(explicit)
            transactions = sorted(
                (e for e in month_entries if e["entry_type"] != "carryover"),
                key=lambda e: (e["transaction_date"], e["sort_order"], e["id"]),
            )
            ws = wb.create_sheet(f"{DEPARTMENT}({month}월)")
            opening = monthly_sheet(
                ws,
                f"{year}년 {month}월",
                transactions,
                receipt_refs,
                opening,
                recorded_carry=sum(explicit) if explicit else None,
            )
    if undated:
        monthly_sheet(
            wb.create_sheet("날짜 미확인"), f"{year}년 날짜 미확인 거래", undated, receipt_refs
        )
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
