# Scheduler for Persona's recurring tasks and check-ins: Railway starts this every 5 minutes (railway.json);
# it calls the app's run-due endpoint once and exits. Vercel's Hobby cron can only run once a day.
FROM curlimages/curl:8.10.1
ENTRYPOINT []
CMD ["sh", "-c", "curl -fsS --max-time 290 -w ' HTTP %{http_code}\\n' -H \"Authorization: Bearer $CRON_SECRET\" \"$APP_URL/api/automations/run-due\""]
