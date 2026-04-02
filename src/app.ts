import { App } from "@slack/bolt";
import { env } from "./config/env.js";

export const app = new App({
  token: env.SLACK_BOT_TOKEN,
  appToken: env.SLACK_APP_TOKEN,
  socketMode: true,
});
