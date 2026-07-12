/**
 * Optional Telegram notifications.
 * 1. Create a bot with @BotFather, copy the token.
 * 2. Message your bot once, then get your chat id (e.g. via @userinfobot).
 * 3. Run with TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npm start
 */
export function makeTelegram(cfg) {
  if (!cfg.telegramToken || !cfg.telegramChat) return null;
  const url = `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`;
  return async text => {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegramChat, text })
      });
    } catch (e) {
      console.error("[telegram]", e.message);
    }
  };
}
