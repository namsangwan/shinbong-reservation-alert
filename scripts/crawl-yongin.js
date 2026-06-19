import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://publicsports.yongin.go.kr";
const LIST_PATH = "/publicsports/sports/selectFcltyRceptResveListU.do";
const APPLY_PATH = "/publicsports/sports/selectFcltyRceptResveApplyListU.do";
const TIME_PATH = "/publicsports/sports/selectRegistTimeByChosenDateFcltyRceptResveApply.do";

const TARGET = {
  facilityName: process.env.FACILITY_NAME || "신봉 배수지 축구장",
  gu: process.env.SEARCH_FCLTY_GU || "BALCGU",
  emd: process.env.SEARCH_FCLTY_EMD || "BALCGU_02",
  field: process.env.SEARCH_FCLTY_FIELD || "ITEM_02",
  startTime: process.env.TARGET_START_TIME || "20:00",
  endTime: process.env.TARGET_END_TIME || "22:00",
};

const CONFIG = {
  key: process.env.YONGIN_MENU_KEY || "4292",
  searchResveType: process.env.YONGIN_RESERVE_TYPE || "GNRLRESVE",
  statePath: process.env.STATE_PATH || ".state/yongin-notified.json",
  dryRun: process.env.DRY_RUN === "1",
  cookie: process.env.YONGIN_COOKIE || "",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  notifyStatus: process.env.TELEGRAM_NOTIFY_STATUS === "1",
};

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

async function main() {
  const reservations = await findTargetReservations();
  const activeReservations = reservations.filter((item) => item.status.includes("접수중"));

  if (reservations.length === 0) {
    const message = buildTargetMissingMessage();
    console.log(message);
    if (!CONFIG.dryRun) {
      await sendTelegram(message);
    }
    process.exitCode = 2;
    return;
  }

  if (activeReservations.length === 0) {
    console.log("대상 시설은 찾았지만 현재 접수중인 월이 없습니다.");
    printReservations(reservations);
    return;
  }

  const checks = [];
  for (const reservation of activeReservations) {
    checks.push(await checkReservationSlots(reservation));
  }

  const authBlocked = checks.filter((check) => check.authRequired);
  const candidates = checks.flatMap((check) => check.availableSlots);

  printReservations(reservations);

  if (authBlocked.length > 0 && candidates.length === 0) {
    console.log("");
    console.log("시간표 조회가 로그인으로 차단되었습니다.");
    console.log("GitHub Actions에서 계속 진행하려면 YONGIN_COOKIE secret을 넣거나, 로컬/서버 실행으로 전환해야 합니다.");
    for (const check of authBlocked) {
      console.log(`- ${check.reservation.title}: ${check.message}`);
    }
    if (!CONFIG.dryRun) {
      await sendTelegram(buildAuthBlockedMessage(authBlocked));
    }
    process.exitCode = 2;
    return;
  }

  const newSlots = await filterNewSlots(candidates);
  if (newSlots.length === 0) {
    console.log("새로 발견된 평일 20:00~22:00 예약 가능 슬롯이 없습니다.");
    if (!CONFIG.dryRun && CONFIG.notifyStatus) {
      await sendTelegram(buildStatusMessage(reservations, checks));
    }
    return;
  }

  const message = buildAlertMessage(newSlots);
  console.log(message);

  if (!CONFIG.dryRun) {
    await sendTelegram(message);
    await persistNotifiedSlots(newSlots);
  }
}

async function findTargetReservations() {
  const searches = [
    buildSearchParams({
      searchFcltyGu: TARGET.gu,
      searchFcltyEmd: TARGET.emd,
      searchFcltyFieldNm: TARGET.field,
      _searchFcltyFieldNm: "on",
    }),
    buildSearchParams({
      searchKrwd: "신봉",
    }),
    buildSearchParams({
      searchKrwd: TARGET.facilityName,
    }),
  ];

  for (const searchParams of searches) {
    const reservations = await fetchReservationSearch(searchParams);
    if (reservations.length > 0) return reservations;
  }

  return [];
}

function buildSearchParams(extraParams) {
  return new URLSearchParams({
    pageUnit: "8",
    pageIndex: "1",
    checkSearchMonthNow: "false",
    ...extraParams,
  });
}

async function fetchReservationSearch(searchParams) {
  const html = await requestWithRetry(`${BASE_URL}${LIST_PATH}?key=${CONFIG.key}&searchResveType=${CONFIG.searchResveType}`, {
    method: "POST",
    body: searchParams,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
  });

  const cards = html.split('<li class="reserve_box_item">').slice(1);
  return cards
    .map(parseReservationCard)
    .filter((item) => item.title.includes(TARGET.facilityName));
}

function parseReservationCard(cardHtml) {
  const titleBlock = firstMatch(cardHtml, /<div class="reserve_title">\s*([\s\S]*?)<div class="reserve_position">/);
  const title = normalizeText(titleBlock);
  const status = normalizeText(firstMatch(cardHtml, /<button class="reserve_state[^"]*">([\s\S]*?)<\/button>/));
  const href = decodeHtml(firstMatch(cardHtml, /<a href="([^"]*selectFcltyRceptResveViewU\.do[^"]*)"/));
  const resveId = firstMatch(href, /resveId=(\d+)/);
  const usePeriod = normalizeText(firstMatch(cardHtml, /이용기간\s*:\s*([0-9.-]+\s*~\s*[0-9.-]+)/));
  const applyUrl = buildApplyUrl(resveId);

  return {
    title,
    status,
    resveId,
    usePeriod,
    detailUrl: toAbsoluteUrl(href),
    applyUrl,
  };
}

function buildApplyUrl(resveId) {
  const params = new URLSearchParams({
    key: CONFIG.key,
    searchResveId: resveId,
    pageUnit: "8",
    pageIndex: "1",
    checkSearchMonthNow: "false",
    searchResveType: CONFIG.searchResveType,
    searchFcltyGu: TARGET.gu,
    searchFcltyEmd: TARGET.emd,
    searchFcltyFieldNm: TARGET.field,
  });
  return `${BASE_URL}${APPLY_PATH}?${params}`;
}

async function checkReservationSlots(reservation) {
  const html = await requestWithRetry(reservation.applyUrl);
  const message = extractMessage(html);

  if (isAuthBlockedPage(html, message)) {
    return {
      reservation,
      authRequired: true,
      message: message || "로그인 필요 응답",
      html,
      availableSlots: [],
    };
  }

  return {
    reservation,
    authRequired: false,
    message: "",
    html,
    availableSlots: await parseAvailableSlots(html, reservation),
  };
}

function isAuthBlockedPage(html, message) {
  return (
    html.includes("<title>안내메시지") &&
    html.includes("window.history.back()") &&
    (message.includes("로그인") || message.includes("잘못된 접근"))
  );
}

async function parseAvailableSlots(html, reservation) {
  const slots = [];
  const availableDates = parseAvailableCalendarDates(html).filter(isWeekday);

  for (const date of availableDates) {
    const timeData = await fetchTimeData(reservation.resveId, date);
    const targetSlot = (timeData.resveTmList || []).find((slot) => normalizeTimeRange(slot.timeContent) === targetTimeRange());
    if (!targetSlot) continue;

    slots.push({
      id: `${reservation.resveId}:${date}:${targetTimeRange()}`,
      facilityName: TARGET.facilityName,
      title: reservation.title,
      date,
      weekday: WEEKDAY_LABELS[new Date(`${date}T00:00:00+09:00`).getDay()],
      time: targetTimeRange(),
      url: reservation.applyUrl,
      sourceText: JSON.stringify(targetSlot),
    });
  }

  return dedupeById(slots);
}

function parseAvailableCalendarDates(html) {
  const dates = [];
  const pattern = /<td class="day_cell[^"]*" attr="(\d{8})"[\s\S]*?<button[^>]*calContentType="Y"[\s\S]*?접수가능[\s\S]*?<\/button>/g;
  for (const match of html.matchAll(pattern)) {
    dates.push(formatCompactDate(match[1]));
  }
  return dates;
}

async function fetchTimeData(resveId, date) {
  const body = new URLSearchParams({
    dateVal: date.replaceAll("-", ""),
    resveId,
  });

  const raw = await requestWithRetry(`${BASE_URL}${TIME_PATH}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json, text/javascript, */*; q=0.01",
    },
  });

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`시간표 JSON 파싱 실패: ${date} ${raw.slice(0, 500)}`);
  }
}

function formatCompactDate(value) {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function targetTimeRange() {
  return `${TARGET.startTime}~${TARGET.endTime}`;
}

function normalizeTimeRange(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/(\d{1,2}):00/g, (_, hour) => `${hour.padStart(2, "0")}:00`);
}

function isWeekday(date) {
  const day = new Date(`${date}T00:00:00+09:00`).getDay();
  return day >= 1 && day <= 5;
}

async function filterNewSlots(slots) {
  const notified = await readNotifiedSlots();
  return slots.filter((slot) => !notified.has(slot.id));
}

async function readNotifiedSlots() {
  try {
    const raw = await fs.readFile(CONFIG.statePath, "utf8");
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed.notifiedSlotIds) ? parsed.notifiedSlotIds : []);
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
}

async function persistNotifiedSlots(slots) {
  const notified = await readNotifiedSlots();
  for (const slot of slots) notified.add(slot.id);

  await fs.mkdir(path.dirname(CONFIG.statePath), { recursive: true });
  await fs.writeFile(
    CONFIG.statePath,
    `${JSON.stringify({ updatedAt: new Date().toISOString(), notifiedSlotIds: [...notified].sort() }, null, 2)}\n`,
  );
}

function buildAlertMessage(slots) {
  const lines = [
    "[용인시 체육시설 취소분 발견]",
    "",
    `${TARGET.facilityName} 평일 ${TARGET.startTime}~${TARGET.endTime}`,
    "",
  ];

  for (const slot of slots) {
    lines.push(`- ${slot.date} (${slot.weekday}) ${slot.time}`);
  }

  lines.push("", slots[0].url);
  return lines.join("\n");
}

function buildStatusMessage(reservations, checks) {
  const now = formatKst(new Date());
  const checkedDates = checks.reduce((count, check) => count + parseAvailableCalendarDates(check.html || "").filter(isWeekday).length, 0);
  const lines = [
    "[용인시 체육시설 크롤링 정상]",
    "",
    `확인시각: ${now}`,
    `시설: ${TARGET.facilityName}`,
    `조건: 평일 ${TARGET.startTime}~${TARGET.endTime}`,
    `결과: 새 예약 가능 슬롯 없음`,
    "",
    "검색 결과:",
  ];

  for (const item of reservations) {
    lines.push(`- ${item.title} / ${item.status} / ${item.usePeriod || "이용기간 알 수 없음"}`);
  }

  lines.push("", `확인한 평일 접수가능 날짜 수: ${checkedDates}`);
  return lines.join("\n");
}

function buildAuthBlockedMessage(authBlocked) {
  const now = formatKst(new Date());
  const lines = [
    "[용인시 체육시설 크롤링 경고]",
    "",
    `확인시각: ${now}`,
    `시설: ${TARGET.facilityName}`,
    "상태: 로그인 세션이 만료되었거나 시간표 조회가 차단되었습니다.",
    "",
    "조치: 용인시 예약 사이트에 다시 로그인한 뒤 GitHub Secret YONGIN_COOKIE를 갱신하세요.",
    "",
    "차단된 예약:",
  ];

  for (const check of authBlocked) {
    lines.push(`- ${check.reservation.title}: ${check.message}`);
  }

  return lines.join("\n");
}

function buildTargetMissingMessage() {
  return [
    "[용인시 체육시설 크롤링 경고]",
    "",
    `확인시각: ${formatKst(new Date())}`,
    `시설: ${TARGET.facilityName}`,
    "상태: 예약 목록에서 대상 시설을 찾지 못했습니다.",
    "",
    "가능한 원인: 용인시 사이트 일시 응답 이상, 검색 결과 구조 변경, 접수 월 전환 중 일시적 공백.",
    "조치: 다음 실행에서 자동 재시도합니다. 같은 경고가 반복되면 사이트 화면 또는 크롤러 파서를 확인하세요.",
  ].join("\n");
}

function formatKst(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

async function sendTelegram(message) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
    throw new Error("예약 가능 슬롯을 찾았지만 Telegram secret이 없어 알림을 보낼 수 없습니다.");
  }

  const url = `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CONFIG.telegramChatId,
      text: message,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram 전송 실패: ${response.status} ${await response.text()}`);
  }
}

async function requestWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(1000 * attempt);
      }
    }
  }
  throw lastError;
}

async function request(url, options = {}) {
  const headers = {
    "user-agent": "Mozilla/5.0 (compatible; YonginPublicSportsAlert/0.1; +https://github.com/)",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    ...(options.headers || {}),
  };

  if (CONFIG.cookie) headers.cookie = CONFIG.cookie;

  const response = await fetch(url, { ...options, headers, redirect: "follow" });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${url}\n${text.slice(0, 500)}`);
  }

  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessage(html) {
  const encoded = firstMatch(html, /decodeURIComponent\("([^"]+)"\)/);
  if (encoded) return decodeURIComponent(encoded);
  return normalizeText(firstMatch(html, /<body[^>]*>([\s\S]*?)<\/body>/));
}

function printReservations(reservations) {
  console.log("대상 시설 검색 결과:");
  for (const item of reservations) {
    console.log(`- ${item.title} / ${item.status} / 이용기간 ${item.usePeriod || "알 수 없음"} / resveId ${item.resveId}`);
  }
}

function toAbsoluteUrl(href) {
  if (!href) return "";
  return new URL(decodeHtml(href).replace(/^\.\//, "/publicsports/sports/"), BASE_URL).toString();
}

function firstMatch(value, pattern) {
  if (!value) return "";
  const match = value.match(pattern);
  if (!match) return "";
  if (match.length >= 4) return match.slice(1).join(".");
  return match[1] || "";
}

function matchAll(value, pattern) {
  return [...value.matchAll(pattern)].map((match) => match[1]);
}

function normalizeText(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function dedupeById(slots) {
  const seen = new Set();
  return slots.filter((slot) => {
    if (seen.has(slot.id)) return false;
    seen.add(slot.id);
    return true;
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
