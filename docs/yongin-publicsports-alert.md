# 용인시 체육시설 취소분 알림 설계

## 목표

- 대상: 용인시 공공체육시설 통합예약 일반예약
- 시설: 신봉 배수지 축구장
- 조건: 평일 20:00~22:00 예약 취소분 또는 예약 가능 슬롯
- 주기: 30분마다
- 알림: Telegram

## 현재 확인한 사실

2026-06-18 기준으로 일반예약 목록은 비로그인 상태에서도 조회된다.

- 검색 조건 `수지구(BALCGU)`, `신봉동(BALCGU_02)`, `축구(ITEM_02)`로 신봉 배수지 축구장만 좁힐 수 있다.
- 검색 결과에 6월 예약 `resveId=12786`, 7월 예약 `resveId=12953`이 나타난다.
- 6월 예약은 `접수중`, 7월 예약은 `접수대기`로 표시된다.
- 시설 상세 페이지도 비로그인 상태에서 조회된다.
- 실제 날짜/시간 선택 페이지 `selectFcltyRceptResveApplyListU.do`는 비로그인 상태에서 `잘못된 접근입니다. 로그인 후 접근바랍니다.` 응답을 반환한다.
- 로그인된 `JSESSIONID`를 `YONGIN_COOKIE`로 전달하면 날짜/시간 선택 페이지와 날짜별 시간 AJAX 조회가 가능했다.
- 날짜별 시간 AJAX 응답에서 예약 가능한 시간은 `resveTmList`, 이미 예약된 시간은 `fcltRceptRsvctmTime`로 구분된다.

따라서 GitHub Actions로도 크롤링은 가능하지만, 실제 시간표 확인에는 로그인 세션 쿠키가 필요하다.

## 추천 구조

```text
GitHub Actions cron, 30분마다
  -> scripts/crawl-yongin.js
  -> 공개 목록에서 신봉 배수지 축구장 접수중 예약 찾기
  -> 신청 시간표 URL 조회
  -> 평일 20:00~22:00 예약 가능 슬롯 필터링
  -> 새 슬롯이면 Telegram 취소분 알림
  -> 새 슬롯이 없어도 정상 크롤링 상태 알림
  -> 로그인 세션이 풀리면 Telegram 경고 알림
  -> 알림 이력 .state/yongin-notified.json 갱신
```

## 로그인 문제 대응

1. GitHub Secrets의 `YONGIN_COOKIE`에 로그인된 쿠키를 저장한다.
2. 시간표 URL이 로그인 차단되면 쿠키가 만료되었거나 본인인증 세션이 풀린 것으로 보고 쿠키를 갱신한다.
3. 쿠키가 짧게 만료되거나 본인인증 세션에 묶여 있으면 GitHub Actions 대신 로컬 Mac `launchd` 또는 작은 VPS에서 실행한다.

자동 예약은 하지 않는다. 이 시스템은 빈 시간 감지와 알림 전송만 담당한다.

## 필요한 GitHub Secrets

- `TELEGRAM_BOT_TOKEN`: Telegram BotFather에서 발급한 토큰
- `TELEGRAM_CHAT_ID`: 알림 받을 채팅 ID
- `YONGIN_COOKIE`: 로그인된 용인시 예약 사이트 쿠키. 예: `JSESSIONID=...`

## 로컬 실행

```bash
npm run check:dry
```

비로그인 시간표 접근이 막히면 종료 코드 `2`로 끝나며, 로그에 로그인 필요 메시지를 출력한다.

Telegram 전송까지 테스트하려면 다음 환경변수를 넣는다.

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npm run check
```

## 운영 메모

- 30분마다 실행하면서 로그인 세션이 유지되는지 확인한다.
- 정상 크롤링도 Telegram으로 알려주도록 GitHub Actions에서 `TELEGRAM_NOTIFY_STATUS=1`을 설정한다.
- 공공 사이트에 불필요한 반복 요청을 보내지 않도록 대상 검색 결과와 접수중 예약만 조회한다.
- `YONGIN_COOKIE`는 계정 세션이므로 GitHub Secrets에만 저장하고 로그에 출력하지 않는다.
