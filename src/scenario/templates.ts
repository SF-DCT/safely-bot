/**
 * テンプレート変数展開
 * {{contact_name}} → 実際の値に置換
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    return variables[key] ?? `{{${key}}}`;
  });
}

/**
 * Enrollment の contact_data + 基本フィールドから変数マップを構築
 */
export function buildVariables(
  contactEmail: string,
  contactName: string | null,
  contactData: Record<string, unknown>,
): Record<string, string> {
  const vars: Record<string, string> = {
    contact_email: contactEmail,
    contact_name: contactName ?? "お客様",
    today: new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }),
  };

  // contact_data の値を文字列として展開
  for (const [key, value] of Object.entries(contactData)) {
    if (value != null) {
      vars[key] = String(value);
    }
  }

  return vars;
}
