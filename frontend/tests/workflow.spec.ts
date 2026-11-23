import { test, expect } from "@playwright/test";

test("행사 생성 → 지출 입력·저장 → 항목 변경 → Excel → 다시 열기", async ({
  page,
  request,
}) => {
  const name = `브라우저 검증 ${Date.now()}`;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "행사의 모든 지출, 한눈에." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "＋ 새 행사", exact: true }).click();
  const form = page.getByRole("dialog", { name: "새 행사 만들기" });
  await form.getByLabel("행사명", { exact: true }).fill(name);
  await form.getByLabel("시작일", { exact: true }).fill("2026-11-08");
  await form.getByLabel("종료일", { exact: true }).fill("2026-11-15");
  await form.getByRole("button", { name: "행사 만들기", exact: true }).click();
  const detail = page.getByRole("region", {
    name: "지출내역(구매LIST)",
    exact: true,
  });
  await expect(
    detail.getByRole("heading", { name, exact: false }),
  ).toBeVisible();
  await detail.getByRole("tab", { name: /지출내역/ }).click();
  await detail.getByRole("button", { name: "＋ 행 추가", exact: true }).click();
  await detail.getByLabel("1행 품목", { exact: true }).fill("옛날간식");
  await detail.getByLabel("1행 총계", { exact: true }).fill("100700");
  await detail.getByLabel("1행 구매처", { exact: true }).fill("쿠팡");
  const expenseReviewed = detail.getByRole("checkbox", {
    name: "1행 검토 완료",
    exact: true,
  });
  await expenseReviewed.uncheck();
  await detail.getByRole("checkbox", { name: "1행 선택", exact: true }).check();
  await detail.getByRole("button", { name: "일괄 검토", exact: true }).click();
  await expect(expenseReviewed).toBeChecked();
  await expect(detail.locator(".total-box")).toContainText("100,700");
  await detail.getByRole("tab", { name: /영수증 관리/ }).click();
  const saveNotice = page.getByRole("dialog", { name: "저장 안내" });
  await expect(saveNotice).toBeInViewport();
  await expect(saveNotice).toContainText("임시 저장");
  await saveNotice.getByRole("button", { name: "확인", exact: true }).click();
  await expect(detail.getByRole("tab", { name: /지출내역/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // A dirty modal warns and stays open when the user declines.
  page.once("dialog", (d) => d.dismiss());
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "임시 저장", exact: true }).click();
  await expect(detail.locator(".record-actions")).toContainText(
    "모든 변경사항이 저장",
  );
  await detail.getByRole("tab", { name: /항목 관리/ }).click();
  await detail.getByLabel("음식/선물 이름", { exact: true }).fill("간식·선물");
  await detail
    .getByRole("row")
    .filter({ has: page.getByLabel("음식/선물 이름", { exact: true }) })
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    detail.getByLabel("간식·선물 이름", { exact: true }),
  ).toBeVisible();
  await detail.getByRole("tab", { name: /지출내역/ }).click();
  await expect(detail.getByLabel("1행 항목", { exact: true })).toContainText(
    "간식·선물",
  );
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    detail.getByRole("button", { name: "↧ Excel", exact: true }).click(),
  ]);
  expect(file.suggestedFilename()).toBe(`DRAFT_${name}_지출내역.xlsx`);
  await detail.getByRole("button", { name: "↥ Excel 장부 업로드" }).click();
  await expect(
    page.getByRole("dialog", { name: "Excel 가져오기", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Excel 가져오기", exact: true }),
  ).not.toBeVisible();
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "저장 후 목록" }).click();
  await page
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("button", { name: "상세 ↗" })
    .click();
  await expect(detail.getByLabel("1행 품목", { exact: true })).toHaveValue(
    "옛날간식",
  );
  await expect(detail.locator(".total-box")).toContainText("100,700");
  await page.screenshot({
    path: "test-results/expense-desktop.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(detail.locator(".modal-footer")).toBeInViewport();
  await page.screenshot({
    path: "test-results/expense-mobile.png",
    fullPage: false,
  });
  await detail.getByRole("button", { name: "저장 후 목록" }).click();
  const list = await (await request.get("/api/events")).json();
  const created = list.find((e: { name: string }) => e.name === name);
  await request.delete(`/api/events/${created.id}`);
  expect(errors).toEqual([]);
});

test("영수증 ZIP 업로드 → 검토 → 배분 연결 → 정리 ZIP", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/events", {
    data: {
      name: `영수증 검증 ${Date.now()}`,
      start_date: "2026-11-08",
      end_date: "2026-11-15",
    },
  });
  const event = await created.json();
  try {
    await request.post(`/api/events/${event.id}/expenses`, {
      data: {
        category_id: event.categories[0].id,
        expense_date: "2026-11-08",
        item_name: "테스트 간식",
        amount_krw: 5000,
        vendor: "BPMC",
      },
    });
    await page.goto("/");
    await page
      .getByRole("row")
      .filter({ hasText: event.name })
      .getByRole("button", { name: "상세 ↗" })
      .click();
    const detail = page.getByRole("region", {
      name: "지출내역(구매LIST)",
      exact: true,
    });
    await detail.getByRole("tab", { name: /영수증 관리/ }).click();
    await detail
      .locator("input[type=file]")
      .setInputFiles("tests/fixtures/receipt.zip");
    const receiptRow = detail
      .getByRole("row")
      .filter({ hasText: "receipt.png" });
    await expect(receiptRow).toBeVisible();
    const analysisSelection = receiptRow.getByRole("checkbox", {
      name: "영수증 1번 선택",
    });
    await expect(analysisSelection).toBeChecked();
    const startAnalysis = detail.getByRole("button", {
      name: /영수증 분석 시작/,
    });
    const analysisDialog = page.getByRole("dialog", {
      name: "영수증 분석 시작 확인",
    });
    await startAnalysis.click();
    await expect(analysisDialog).toContainText("영수증 1장");
    await analysisDialog
      .getByRole("button", { name: "취소", exact: true })
      .click();
    await expect(analysisDialog).toBeHidden();
    await expect(analysisSelection).toBeChecked();
    await analysisSelection.uncheck();
    await expect(startAnalysis).toBeDisabled();
    await receiptRow.click();
    const review = page.getByRole("dialog", { name: "영수증 검토" });
    await expect(
      review.getByRole("img", { name: "receipt.png 영수증 원본" }),
    ).toBeVisible();
    await review
      .getByRole("button", { name: "중복 제외", exact: true })
      .click();
    await expect(receiptRow).toContainText("제외");
    await expect(
      review.getByRole("button", { name: "제외 해제", exact: true }),
    ).toBeEnabled();
    page.once("dialog", (dialog) => dialog.accept());
    await review
      .getByRole("button", { name: "제외 해제", exact: true })
      .click();
    await expect(receiptRow).toContainText("대기");
    await expect(
      review.getByRole("button", { name: "검토값 확인", exact: true }),
    ).toBeVisible();
    await review
      .getByLabel("거래일시", { exact: true })
      .fill("2026-11-08T09:15");
    await review.getByLabel("상호명", { exact: true }).fill("BPMC");
    await review.getByLabel("최종 결제금액", { exact: true }).fill("5000");
    await review.getByLabel("사용 내역", { exact: true }).fill("테스트 간식");
    const reviewReason = review.getByLabel("검토 사유", { exact: true });
    await reviewReason.fill("원본에서 결제금액을 직접 확인함");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.keyboard.press("Escape");
    await expect(review.getByLabel("상호명", { exact: true })).toHaveValue(
      "BPMC",
    );
    await review
      .getByRole("button", { name: "검토값 확인", exact: true })
      .click();
    await expect(receiptRow).toContainText("확인됨");
    await expect(reviewReason).toHaveValue("원본에서 결제금액을 직접 확인함");
    await expect(
      review.getByRole("button", {
        name: /추천 #1 · 2026-11-08 · 테스트 간식/,
      }),
    ).toBeVisible();
    await review
      .getByLabel("연결 지출 선택", { exact: true })
      .selectOption({ label: "#1 · 2026-11-08 · 테스트 간식 (₩ 5,000)" });
    await review.getByLabel("배분금액", { exact: true }).fill("5000");
    await review
      .getByRole("button", { name: "연결 확정", exact: true })
      .click();
    await expect(review.locator(".existing-link")).toContainText(
      "#1 · 2026-11-08 · 테스트 간식 · ₩ 5,000",
    );
    await review.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(review).toBeHidden();
    await expect(receiptRow).toBeFocused();
    await receiptRow.press("Enter");
    await expect(reviewReason).toHaveValue("원본에서 결제금액을 직접 확인함");
    await expect(reviewReason).toBeDisabled();
    await expect(
      review.getByLabel("최종 결제금액", { exact: true }),
    ).toBeDisabled();
    const receipt = (
      await (await request.get(`/api/events/${event.id}/receipts`)).json()
    )[0];
    const blockedEdit = await request.patch(`/api/receipts/${receipt.id}`, {
      data: { ...receipt, merchant: "확인된 값 수정 시도" },
    });
    expect(blockedEdit.status()).toBe(409);
    await review.getByRole("button", { name: "재검토", exact: true }).click();
    await expect(receiptRow).toContainText("검토 필요");
    await expect(reviewReason).toBeEnabled();
    await reviewReason.fill("재검토 후 원본과 일치 확인");
    await review
      .getByRole("button", { name: "검토값 확인", exact: true })
      .click();
    await expect(receiptRow).toContainText("확인됨");
    await expect(reviewReason).toBeDisabled();
    await expect(reviewReason).toHaveValue("재검토 후 원본과 일치 확인");
    await review.getByRole("button", { name: "닫기", exact: true }).click();
    const filters = detail.getByRole("group", { name: "영수증 검색" });
    await filters.getByLabel("거래 시작일").fill("2026-11-08");
    await filters.getByLabel("거래 종료일").fill("2026-11-08");
    const amountFilter = filters.getByLabel("금액", { exact: true });
    await amountFilter.fill("5000");
    const statusDropdown = filters.locator(".receipt-status-filters > summary");
    const confirmedFilter = filters.getByRole("checkbox", {
      name: "확인됨",
      exact: true,
    });
    const needsReviewFilter = filters.getByRole("checkbox", {
      name: "검토 필요",
      exact: true,
    });
    await expect(confirmedFilter).toBeHidden();
    await statusDropdown.click();
    const allStatuses = filters.getByRole("checkbox", {
      name: "전체 선택",
      exact: true,
    });
    await allStatuses.check();
    await expect(confirmedFilter).toBeChecked();
    await expect(needsReviewFilter).toBeChecked();
    await allStatuses.uncheck();
    await expect(confirmedFilter).not.toBeChecked();
    await expect(needsReviewFilter).not.toBeChecked();
    await confirmedFilter.check();
    await needsReviewFilter.check();
    await expect(statusDropdown).toHaveText("상태 2개 선택");
    await statusDropdown.click();
    await expect(confirmedFilter).toBeHidden();
    await expect(filters.getByRole("status")).toHaveText("검색 결과 1건");
    await filters.getByLabel("거래 종료일").fill("2026-11-07");
    await expect(receiptRow).toHaveCount(0);
    await filters.getByLabel("거래 종료일").fill("2026-11-08");
    await amountFilter.fill("4999");
    await expect(receiptRow).toHaveCount(0);
    await amountFilter.fill("5001");
    await expect(receiptRow).toHaveCount(0);
    await amountFilter.fill("5000");
    await statusDropdown.click();
    await confirmedFilter.uncheck();
    await expect(receiptRow).toHaveCount(0);
    await detail.getByRole("tab", { name: /지출내역/ }).click();
    await detail.getByRole("tab", { name: /영수증 관리/ }).click();
    await expect(amountFilter).toHaveValue("5000");
    await expect(statusDropdown).toHaveText("상태 1개 선택");
    await statusDropdown.click();
    await expect(needsReviewFilter).toBeChecked();
    await expect(confirmedFilter).not.toBeChecked();
    await expect(receiptRow).toHaveCount(0);
    const excludedFilter = filters.getByRole("checkbox", {
      name: "제외",
      exact: true,
    });
    await excludedFilter.check();
    await expect(excludedFilter).toBeChecked();
    await expect(receiptRow).toHaveCount(0);
    await filters.getByRole("button", { name: "초기화", exact: true }).click();
    await detail.getByRole("tab", { name: /지출내역/ }).click();
    await detail.getByRole("tab", { name: /영수증 관리/ }).click();
    await expect(amountFilter).toHaveValue("");
    await expect(statusDropdown).toHaveText("상태 전체");
    await expect(receiptRow).toBeVisible();
    const amountHeader = detail.getByRole("columnheader", {
      name: "최종금액",
      exact: true,
    });
    await amountHeader.getByRole("button").click();
    await expect(amountHeader).toHaveAttribute("aria-sort", "ascending");
    await amountHeader.getByRole("button").click();
    await expect(amountHeader).toHaveAttribute("aria-sort", "descending");
    const [zip] = await Promise.all([
      page.waitForEvent("download"),
      detail.getByRole("button", { name: "↧ 영수증 ZIP", exact: true }).click(),
    ]);
    expect(zip.suggestedFilename()).toBe(`DRAFT_${event.name}_영수증.zip`);
    await detail.getByRole("tab", { name: /지출내역/ }).click();
    await expect(detail.locator(".expense-table")).toContainText("5,000");
    const receiptNumber = detail.getByRole("link", { name: "#1", exact: true });
    await receiptNumber.click();
    await expect(reviewReason).toHaveValue("재검토 후 원본과 일치 확인");
    await expect(
      review.getByRole("button", { name: "재검토", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(review).toBeHidden();
    await expect(receiptNumber).toBeFocused();

    const expenseItem = detail.getByLabel("1행 품목", { exact: true });
    await expenseItem.fill("저장하지 않은 품목");
    await receiptNumber.click();
    await expect(
      review.getByRole("button", { name: "재검토", exact: true }),
    ).toBeDisabled();
    await review.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(expenseItem).toHaveValue("저장하지 않은 품목");
    await expenseItem.fill("테스트 간식");
    await detail.getByRole("tab", { name: /영수증 관리/ }).click();
    await analysisSelection.check();
    await startAnalysis.click();
    const [analysisResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/events/${event.id}/receipts/analyze`) &&
          response.request().method() === "POST",
      ),
      analysisDialog
        .getByRole("button", { name: "분석 시작", exact: true })
        .click(),
    ]);
    expect(analysisResponse.status()).toBe(202);
    expect(analysisResponse.request().postDataJSON()).toEqual({
      receipt_ids: [receipt.id],
    });
    await expect(detail.getByText(/분석 작업 완료/)).toBeVisible();
    const completedAnalysis = page.getByRole("dialog", {
      name: "영수증 분석 완료",
    });
    await expect(completedAnalysis).toContainText("1장 중 1장을 처리했습니다");
    await completedAnalysis
      .getByRole("button", { name: "확인", exact: true })
      .click();
    await expect(completedAnalysis).toBeHidden();
    await receiptRow.click();
    await review.getByRole("button", { name: "재검토", exact: true }).click();
    await expect(receiptRow).toContainText("검토 필요");
    await review.getByRole("button", { name: "닫기", exact: true }).click();
    await analysisSelection.check();
    await detail
      .getByRole("button", { name: "일괄 검토", exact: true })
      .click();
    await expect(receiptRow).toContainText("확인됨");
    const deleteSelected = detail.getByRole("button", {
      name: /선택 영수증 삭제/,
    });
    page.once("dialog", (dialog) => dialog.dismiss());
    await deleteSelected.click();
    await expect(receiptRow).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await deleteSelected.click();
    await expect(receiptRow).toHaveCount(0);
    await detail.getByRole("tab", { name: /지출내역/ }).click();
    await expect(expenseItem).toHaveValue("테스트 간식");
    await expect(receiptNumber).toHaveCount(0);
  } finally {
    await request.delete(`/api/events/${event.id}`).catch(() => {});
  }
});

test("최종 확정 잠금 → 재오픈 → 재확정 → v1/v2 이력", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/events", {
    data: {
      name: `확정 검증 ${Date.now()}`,
      event_date: "2026-11-15",
      start_date: "2026-11-08",
      end_date: "2026-11-15",
    },
  });
  const event = await created.json();
  try {
    await request.post(`/api/events/${event.id}/expenses`, {
      data: {
        category_id: event.categories[0].id,
        expense_date: "2026-11-08",
        item_name: "현금 구매",
        amount_krw: 8000,
      },
    });
    await page.goto("/");
    await page
      .getByRole("row")
      .filter({ hasText: event.name })
      .getByRole("button", { name: "상세 ↗" })
      .click();
    const detail = page.getByRole("region", {
      name: "지출내역(구매LIST)",
      exact: true,
    });
    await expect(
      detail.getByRole("button", { name: "최종 확정", exact: true }),
    ).toBeEnabled();
    async function confirmFinal(version: number) {
      await detail
        .getByRole("button", { name: "최종 확정", exact: true })
        .click();
      const confirm = page.getByRole("dialog", {
        name: "최종 확정 전 확인",
        exact: true,
      });
      await confirm
        .getByLabel("승인 사유", { exact: true })
        .fill("영수증 없는 현금 지출, 담당자 확인");
      await confirm.getByRole("checkbox").check();
      await confirm
        .getByRole("button", { name: `최종 확정 v${version}`, exact: true })
        .click();
      await expect(confirm).not.toBeVisible();
    }
    await confirmFinal(1);
    await expect(detail.getByLabel("1행 총계", { exact: true })).toBeDisabled();
    await expect(detail.locator(".workflow-banner")).toContainText("v1");
    await detail
      .getByRole("button", { name: "수정 재오픈", exact: true })
      .click();
    await detail.getByLabel("1행 총계", { exact: true }).fill("7500");
    await detail
      .getByRole("button", { name: "임시 저장", exact: true })
      .click();
    await expect(detail.locator(".record-actions")).toContainText(
      "모든 변경사항이 저장",
    );
    await confirmFinal(2);
    await detail.getByRole("tab", { name: /변경 이력/ }).click();
    const v1 = detail
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "v1", exact: true }) });
    await expect(v1).toContainText("8,000");
    await expect(
      detail
        .getByRole("row")
        .filter({ has: page.getByRole("cell", { name: "v2", exact: true }) }),
    ).toContainText("7,500");
    const [file] = await Promise.all([
      page.waitForEvent("download"),
      v1.getByRole("button", { name: "Excel", exact: true }).click(),
    ]);
    expect(file.suggestedFilename()).toBe(`${event.name}_v1.xlsx`);
  } finally {
    await request.delete(`/api/events/${event.id}`).catch(() => {});
  }
});

test("LLM 분석 이력의 사용량 표시와 후보값 수동 반영", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/events", {
    data: {
      name: `LLM 화면 검증 ${Date.now()}`,
      start_date: "2026-11-08",
      end_date: "2026-11-15",
    },
  });
  const event = await created.json();
  try {
    // Mock only the history response; no external paid API is used by browser tests.
    await page.route("**/api/receipts/*/extractions", (route) =>
      route.fulfill({
        json: [
          {
            id: 1,
            analyzed_at: "2026-11-17T09:00:00Z",
            model_name: "gpt-4.1-mini-test",
            input_kind: "image",
            usage_json: JSON.stringify({
              input_tokens: 100,
              output_tokens: 40,
            }),
            estimated_cost_usd: "0.00018",
            error_message: "",
            extracted_json: JSON.stringify({
              transaction_at: "2026-11-08T09:15:00",
              merchant: "LLM 테스트 상점",
              description: "간식 구매",
              final_amount_krw: 7500,
              review_reason: "",
              ocr_status: "검토 필요",
              ocr_text: "",
            }),
          },
        ],
      }),
    );
    await page.goto("/");
    await page
      .getByRole("row")
      .filter({ hasText: event.name })
      .getByRole("button", { name: "상세 ↗" })
      .click();
    const detail = page.getByRole("region", {
      name: "지출내역(구매LIST)",
      exact: true,
    });
    await detail.getByRole("tab", { name: /영수증 관리/ }).click();
    await expect(detail).toContainText("외부 LLM 꺼짐");
    await detail
      .locator("input[type=file]")
      .setInputFiles("tests/fixtures/receipt.zip");
    await detail.getByRole("row").filter({ hasText: "receipt.png" }).click();
    await detail.getByText("분석 이력·현재 값 비교", { exact: false }).click();
    const comparison = detail.locator(".extraction-comparison");
    await expect(comparison).toContainText("gpt-4.1-mini-test");
    await expect(comparison).toContainText("입력 토큰 100 / 출력 토큰 40");
    await expect(comparison).toContainText("$0.00018");
    page.once("dialog", (dialog) => dialog.accept());
    await comparison
      .getByRole("button", { name: "이 후보를 검토폼에 가져오기", exact: true })
      .click();
    await expect(detail.getByLabel("상호명", { exact: true })).toHaveValue(
      "LLM 테스트 상점",
    );
    await expect(
      detail.getByLabel("최종 결제금액", { exact: true }),
    ).toHaveValue("7500");
    await detail
      .getByRole("button", { name: "검토값 확인", exact: true })
      .click();
    await expect(
      detail.getByRole("row").filter({ hasText: "receipt.png" }),
    ).toContainText("확인됨");
  } finally {
    await request.delete(`/api/events/${event.id}`).catch(() => {});
  }
});
