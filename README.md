# Shinbong Reservation Alert

신봉 배수지 축구장 평일 20:00~22:00 예약 취소분을 확인하고 Telegram으로 알려주는 GitHub Actions 크롤러입니다.

운영은 외부 cron 서비스가 GitHub Actions `workflow_dispatch` API를 30분마다 호출하는 방식을 권장합니다. GitHub Actions 자체 `schedule`도 남겨두었지만, GitHub 스케줄은 지연되거나 누락될 수 있습니다.

## What It Checks

- 사이트: 용인시 공공체육시설 통합예약
- 시설: 신봉 배수지 축구장
- 조건: 평일 20:00~22:00
- 주기: 외부 cron에서 30분마다 GitHub Actions 수동 실행 API 호출
- 알림: Telegram. 평일 20:00~22:00 빈 시간이 발견되면 항상 보내고, 로그인 세션 만료/조회 실패 같은 경고는 KST 00:00~07:00에는 보내지 않습니다.
- 용인시 서버의 일시적인 `502/503/504` 오류는 알림 없이 정상 종료합니다.

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

외부 cron에서는 아래 GitHub API를 호출합니다.

```bash
curl -L \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <GITHUB_TOKEN>" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/namsangwan/shinbong-reservation-alert/actions/workflows/yongin-publicsports-alert.yml/dispatches \
  -d '{"ref":"main"}' \
  -w "\nHTTP_STATUS=%{http_code}\n"
```

성공하면 `HTTP_STATUS=204`가 반환됩니다.

자세한 운영 메모는 [docs/yongin-publicsports-alert.md](docs/yongin-publicsports-alert.md)를 참고하세요.
