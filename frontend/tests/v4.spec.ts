import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { APIRequestContext, Page } from "@playwright/test";
const owners: number[] = [];
test.afterEach(async ({ request }) => {
  for (const id of owners.splice(0).reverse())
    await request.delete(`/api/events/${id}`).catch(() => {});
});
async function remember(
  request: APIRequestContext,
  kind: string,
  year: number,
) {
  const list = await (await request.get(`/api/${kind}/books`)).json();
  const b = list.find((x: { year: number }) => x.year === year);
  expect(b).toBeTruthy();
  owners.push(b.owner_event_id);
  return b;
}
async function createYear(page: Page, year: number) {
  await page
    .getByRole("button", { name: "＋ 연도별 장부 생성", exact: true })
    .click();
  const form = page.getByRole("dialog");
  await form.getByLabel("장부 연도", { exact: true }).fill(String(year));
  return form;
}
async function confirmBook(page: Page) {
  await page.getByRole("button", { name: "최종 확정", exact: true }).click();
  const form = page.getByRole("dialog", {
    name: "최종 확정 전 확인",
    exact: true,
  });
  await expect(form.locator(".preview-summary")).toBeVisible();
  const reason = form.getByLabel("승인 사유", { exact: true });
  if (await reason.count()) {
    await reason.fill("사용자 검토 완료 · 현금 지출 증빙 확인");
    await form.getByRole("checkbox").check();
  }
  await form.getByRole("button", { name: "최종 확정 v1", exact: true }).click();
  await expect(form).not.toBeVisible();
}

test("경상비 연도 생성·관항목·거래·확정 집계·새해 예산 복사", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/ordinary");
  let form = await createYear(page, 2026);
  await form
    .getByRole("button", { name: "연도별 장부 생성", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /2026년 경상비/ }),
  ).toBeVisible();
  const original = await remember(request, "ordinary", 2026);
  async function addBudget(level: string, name: string, parent?: string) {
    await page.getByLabel("새 예산 레벨", { exact: true }).selectOption(level);
    if (parent)
      await page
        .getByLabel("상위 예산 항목", { exact: true })
        .selectOption({ label: parent });
    await page.getByLabel("새 예산 항목명", { exact: true }).fill(name);
    await page.getByRole("button", { name: "＋ 예산 항목 추가" }).click();
  }
  await addBudget("1", "공동체");
  await addBudget("2", "운영비", "공동체");
  await addBudget("3", "팀장운영", "공동체 / 운영비");
  await page.getByLabel("팀장운영 예산", { exact: true }).fill("10000");
  await page.getByRole("button", { name: "임시 저장", exact: true }).click();
  await expect(page.locator(".record-actions")).toContainText(
    "현재 장부가 저장",
  );
  await page.getByRole("tab", { name: "경상비 장부", exact: true }).click();
  await page.getByRole("button", { name: "＋ 거래 추가", exact: true }).click();
  const entries = page.locator(".annual-entry-table");
  await expect(
    entries.getByRole("columnheader", { name: "No.", exact: true }),
  ).toBeVisible();
  await expect(
    entries.getByRole("cell", { name: "1", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("1거래 항", { exact: true })
    .selectOption({ label: "운영비" });
  await page
    .getByLabel("1거래 목", { exact: true })
    .selectOption({ label: "팀장운영" });
  await page.getByLabel("1거래 내용", { exact: true }).fill("팀장 모임 간식");
  await page.getByLabel("1거래 지출", { exact: true }).fill("3000");
  const entryReviewed = page.getByRole("checkbox", {
    name: "선택 거래 검토 완료",
    exact: true,
  });
  await entryReviewed.uncheck();
  await page.getByRole("checkbox", { name: "1거래 선택", exact: true }).check();
  await page.getByRole("button", { name: "일괄 검토", exact: true }).click();
  await expect(entryReviewed).toBeChecked();
  await page.getByRole("tab", { name: "영수증 관리", exact: true }).click();
  const saveNotice = page.getByRole("dialog", { name: "저장 안내" });
  await expect(saveNotice).toBeInViewport();
  await expect(saveNotice).toContainText("임시 저장");
  await saveNotice.getByRole("button", { name: "확인", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "경상비 장부", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "임시 저장", exact: true }).click();
  await expect(page.locator(".record-actions")).toContainText(
    "현재 장부가 저장",
  );
  const entrySearch = page.getByLabel("거래 내용 검색", { exact: true });
  await entrySearch.fill("팀장 모임");
  await page.getByRole("tab", { name: "예산 현황", exact: true }).click();
  await page.getByRole("tab", { name: "경상비 장부", exact: true }).click();
  await expect(entrySearch).toHaveValue("팀장 모임");
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  const [churchLedger] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "↧ 교회 장부 Excel", exact: true })
      .click(),
  ]);
  expect(churchLedger.suggestedFilename()).toBe("DRAFT_2026_교회_장부.xlsx");
  const [draftFile] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "↧ Excel", exact: true }).click(),
  ]);
  await page
    .getByRole("button", { name: "↥ Excel 가져오기", exact: true })
    .click();
  const importing = page.getByRole("dialog", {
    name: "장부 Excel 가져오기",
    exact: true,
  });
  await importing.locator("input[type=file]").setInputFiles({
    name: "roundtrip.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: await readFile((await draftFile.path())!),
  });
  await importing
    .getByRole("button", { name: "미리보기 분석", exact: true })
    .click();
  await importing
    .getByRole("checkbox", {
      name: "연도 보완·중복 경고를 확인했습니다.",
      exact: true,
    })
    .check();
  await importing
    .getByRole("radio", { name: "기존 자료 대체", exact: true })
    .check();
  await importing
    .getByRole("checkbox", { name: /기존 자료와 영수증 연결이 변경/ })
    .check();
  await importing
    .getByRole("button", { name: "검토한 자료 반영", exact: true })
    .click();
  await expect(importing).not.toBeVisible();
  await confirmBook(page);
  await page.getByRole("tab", { name: "예산 현황", exact: true }).click();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByLabel("팀장운영 예산", { exact: true }) });
  await expect(row).toContainText("3,000");
  await expect(row).toContainText("7,000");
  await expect(
    page.getByLabel("팀장운영 예산", { exact: true }),
  ).toBeDisabled();
  const [xlsx] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "↧ Excel", exact: true }).click(),
  ]);
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  await page.screenshot({
    path: "test-results/v4-ordinary.png",
    fullPage: false,
  });
  form = await createYear(page, 2027);
  await form
    .getByLabel("예산 항목 초기화", { exact: true })
    .selectOption({ label: "2026년 예산·항목만 복사" });
  await form
    .getByRole("button", { name: "연도별 장부 생성", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /2027년 경상비/ }),
  ).toBeVisible();
  const copied = await remember(request, "ordinary", 2027);
  expect(copied.entries).toHaveLength(0);
  await expect(page.getByLabel("새 예산 레벨", { exact: true })).toHaveValue(
    "1",
  );
  await expect(page.getByLabel("팀장운영 예산", { exact: true })).toHaveValue(
    "₩ 10,000",
  );
  await page
    .getByLabel("경상비 연도 선택", { exact: true })
    .selectOption(String(original.id));
  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByLabel("팀장운영 예산", { exact: true }) }),
  ).toContainText("7,000");
  expect(errors).toEqual([]);
});

test("B 수입·이월·영수증 검토·지출 생성·확정·PPTX ZIP", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/b");
  const form = await createYear(page, 2026);
  await form
    .getByRole("button", { name: "연도별 장부 생성", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: /2026년 B/ })).toBeVisible();
  await remember(request, "b", 2026);
  await expect(
    page.getByRole("tab", { name: "예산 현황", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "＋ 거래 추가", exact: true }).click();
  await page.getByLabel("1거래 내용", { exact: true }).fill("전년도 이월금");
  await page.getByLabel("1거래 수입", { exact: true }).fill("10000");
  await page
    .getByLabel("선택 거래유형", { exact: true })
    .selectOption("carryover");
  await page.getByRole("button", { name: "임시 저장", exact: true }).click();
  await expect(page.locator(".record-actions")).toContainText(
    "현재 장부가 저장",
  );
  await page.getByRole("tab", { name: "영수증 관리", exact: true }).click();
  await page
    .locator("input[type=file]")
    .setInputFiles("tests/fixtures/receipt.zip");
  const receipt = page.getByRole("row").filter({ hasText: "receipt.png" });
  await expect(receipt).toBeVisible();
  await receipt.click();
  await page.getByLabel("거래일시", { exact: true }).fill("2026-11-08T09:15");
  await page.getByLabel("상호명", { exact: true }).fill("B 테스트 상점");
  await page.getByLabel("최종 결제금액", { exact: true }).fill("5000");
  await page.getByLabel("사용 내역", { exact: true }).fill("영수증 간식");
  await page.getByLabel("검토 사유", { exact: true }).fill("");
  await page.getByRole("button", { name: "검토값 확인", exact: true }).click();
  await expect(receipt).toContainText("확인됨");
  await expect(page.getByLabel("새 지출 항목", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "이 영수증으로 지출 생성", exact: true })
    .click();
  await expect(page.locator(".existing-link")).toContainText("5,000");
  await page
    .getByRole("dialog", { name: "영수증 검토" })
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page.getByRole("tab", { name: "B 장부", exact: true }).click();
  await expect(page.getByLabel("1거래 수입", { exact: true })).toHaveValue(
    "₩ 10,000",
  );
  await expect(page.getByLabel("2거래 지출", { exact: true })).toHaveValue(
    "₩ 5,000",
  );
  const entryTable = page.locator(".annual-entry-table");
  const topRow = entryTable.locator("tbody tr").first();
  const numberSort = entryTable.getByRole("button", {
    name: "No.",
    exact: true,
  });
  const dateHeader = entryTable.getByRole("columnheader", {
    name: "날짜",
    exact: true,
  });
  await expect(dateHeader).toHaveAttribute("aria-sort", "ascending");
  await dateHeader.getByRole("button").click();
  await expect(dateHeader).toHaveAttribute("aria-sort", "descending");
  await expect(topRow.getByLabel("2거래 지출", { exact: true })).toHaveValue(
    "₩ 5,000",
  );
  const incomeSort = entryTable.getByRole("button", {
    name: "수입",
    exact: true,
  });
  await incomeSort.click();
  await expect(topRow.getByLabel("2거래 지출", { exact: true })).toBeVisible();
  await incomeSort.click();
  await expect(topRow.getByLabel("1거래 수입", { exact: true })).toBeVisible();
  await numberSort.click();
  await expect(
    topRow.getByRole("cell", { name: "1", exact: true }),
  ).toBeVisible();
  await numberSort.click();
  await expect(
    topRow.getByRole("cell", { name: "2", exact: true }),
  ).toBeVisible();
  const entrySearch = page.getByLabel("거래 내용 검색", { exact: true });
  await entrySearch.fill("영수증 간식");
  await page
    .getByRole("checkbox", { name: "거래 전체 선택", exact: true })
    .check();
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "1거래 선택", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "2거래 선택", exact: true }),
  ).toBeChecked();
  await confirmBook(page);
  await expect(page.locator(".stats")).toContainText("5,000");
  const expenseSort = entryTable.getByRole("button", {
    name: "지출",
    exact: true,
  });
  await expenseSort.click();
  await expect(topRow.getByLabel("1거래 수입", { exact: true })).toBeDisabled();
  await expenseSort.click();
  await expect(topRow.getByLabel("2거래 지출", { exact: true })).toBeDisabled();
  const receiptNumber = page.getByRole("link", { name: "#1", exact: true });
  await receiptNumber.click();
  const review = page.getByRole("dialog", { name: "영수증 검토" });
  await expect(
    review.getByRole("img", { name: "receipt.png 영수증 원본" }),
  ).toBeVisible();
  await expect(
    review.getByRole("button", { name: "재검토", exact: true }),
  ).toBeDisabled();
  await review.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(receiptNumber).toBeFocused();
  let releasePpt = () => {};
  const pptReady = new Promise<void>((resolve) => {
    releasePpt = resolve;
  });
  await page.route(/\/receipts\/export-pptx(?:\?|$)/, async (route) => {
    await pptReady;
    await route.continue();
  });
  const pptDownload = page.waitForEvent("download");
  const loadingPpt = page.getByRole("dialog", { name: "영수증 PPTX 준비 중" });
  try {
    await page.getByRole("button", { name: "↧ PPTX", exact: true }).click();
    await expect(loadingPpt).toBeVisible();
  } finally {
    releasePpt();
  }
  const ppt = await pptDownload;
  await expect(loadingPpt).toBeHidden();
  expect(ppt.suggestedFilename()).toMatch(/\.pptx$/);
  const [zip] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "↧ 영수증 ZIP", exact: true }).click(),
  ]);
  expect(zip.suggestedFilename()).toMatch(/\.zip$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".record-actions").scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "수정 재오픈", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: "test-results/v4-b-mobile.png",
    fullPage: false,
  });
  expect(errors).toEqual([]);
});
