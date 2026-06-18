# Shinbong Reservation Alert

신봉 배수지 축구장 평일 20:00~22:00 예약 취소분을 30분마다 확인하고 Telegram으로 알려주는 GitHub Actions 크롤러입니다.

## What It Checks

- 사이트: 용인시 공공체육시설 통합예약
- 시설: 신봉 배수지 축구장
- 조건: 평일 20:00~22:00
- 주기: 30분마다
- 알림: Telegram

## Required Secrets

GitHub repository settings에서 아래 Actions secrets를 등록하세요.

- `YONGIN_COOKIE`: 로그인된 용인시 예약 사이트 쿠키. 예: `JSESSIONID=...`
- `TELEGRAM_BOT_TOKEN`: Telegram 봇 토큰
- `TELEGRAM_CHAT_ID`: 알림을 받을 채팅 ID

## Run Manually

```bash
npm run check:dry
```

GitHub에서는 `Actions -> Yongin public sports alert -> Run workflow`로 수동 실행할 수 있습니다.

자세한 운영 메모는 [docs/yongin-publicsports-alert.md](docs/yongin-publicsports-alert.md)를 참고하세요.
