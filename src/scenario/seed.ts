import { upsertScenario } from "./repository.js";
import type { Scenario } from "./types.js";

const scenarios: Scenario[] = [
  {
    id: "document_request_drip",
    name: "資料請求フォローアップ",
    description: "資料請求後のドリップキャンペーン: 3日後お礼 → 7日後事例紹介 → 14日後アポ打診",
    trigger_type: "manual",
    trigger_config: {},
    steps: [
      { type: "wait", delay_days: 3 },
      {
        type: "email",
        subject_template: "{{contact_name}}様、先日の資料はご確認いただけましたか？",
        body_template: `{{contact_name}}様

先日は弊社サービスの資料をご請求いただき、誠にありがとうございます。
資料の内容はご確認いただけましたでしょうか？

ご不明な点やご質問がございましたら、お気軽にお問い合わせください。
ご状況に合わせた最適なプランをご提案させていただきます。

株式会社SAFELY
高橋`,
        from_name: "SAFELY 高橋",
      },
      { type: "wait", delay_days: 4 },
      {
        type: "email",
        subject_template: "{{contact_name}}様、導入事例のご紹介",
        body_template: `{{contact_name}}様

いつもお世話になっております。SAFELYの高橋です。

同業種のお客様の導入事例をご紹介させていただきます。
導入後、集客数が平均150%向上した事例もございます。

詳しいご説明をご希望でしたら、30分程度のオンラインMTGも可能です。
ご都合の良い日時をお知らせいただけますと幸いです。

株式会社SAFELY
高橋`,
        from_name: "SAFELY 高橋",
      },
      { type: "wait", delay_days: 7 },
      {
        type: "email",
        subject_template: "{{contact_name}}様、お打ち合わせのご提案",
        body_template: `{{contact_name}}様

何度かご連絡させていただいております、SAFELYの高橋です。

弊社サービスについて、改めてご状況をお伺いし、
最適なプランをご提案させていただければと考えております。

15〜30分のオンラインMTGで、貴社の課題に合わせた
具体的な施策をご提案いたします。

以下よりご都合の良い日時をお選びください。
（ご返信いただく形でも結構です）

ご検討のほど、よろしくお願いいたします。

株式会社SAFELY
高橋`,
        from_name: "SAFELY 高橋",
      },
      {
        type: "slack_notify",
        message_template:
          ":bell: シナリオ完了: {{contact_name}} ({{contact_email}}) — 資料請求フォロー3通目送信済み。アポ取得状況を確認してください。",
      },
    ],
    is_active: true,
  },
  {
    id: "lost_deal_followup",
    name: "失注掘り起こし",
    description: "失注案件の30日後掘り起こしメール + Slack通知",
    trigger_type: "manual",
    trigger_config: {},
    steps: [
      { type: "wait", delay_days: 30 },
      {
        type: "email",
        subject_template: "{{contact_name}}様、その後のご状況はいかがでしょうか",
        body_template: `{{contact_name}}様

ご無沙汰しております。SAFELYの高橋です。

以前ご検討いただいておりました件について、
その後のご状況はいかがでしょうか？

弊社サービスも日々アップデートしており、
以前とは異なるご提案ができる可能性もございます。

もしご興味がございましたら、改めてご説明の機会を
いただけますと幸いです。

引き続きよろしくお願いいたします。

株式会社SAFELY
高橋`,
        from_name: "SAFELY 高橋",
      },
      {
        type: "slack_notify",
        message_template:
          ":recycle: 失注掘り起こし完了: {{contact_name}} ({{contact_email}}) — メール送信済み。反応を確認してください。",
      },
    ],
    is_active: true,
  },
];

export async function seedScenarios(): Promise<void> {
  for (const scenario of scenarios) {
    await upsertScenario(scenario);
  }
  console.log(`[Scenario] Seeded ${scenarios.length} scenario(s).`);
}
