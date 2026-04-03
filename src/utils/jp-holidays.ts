/**
 * 日本の祝日判定ユーティリティ
 * 国民の祝日に関する法律に基づき算出（振替休日含む）
 */

interface Holiday {
  month: number;
  day: number;
  name: string;
}

/** 固定祝日 */
const FIXED_HOLIDAYS: Holiday[] = [
  { month: 1, day: 1, name: "元日" },
  { month: 2, day: 11, name: "建国記念の日" },
  { month: 2, day: 23, name: "天皇誕生日" },
  { month: 4, day: 29, name: "昭和の日" },
  { month: 5, day: 3, name: "憲法記念日" },
  { month: 5, day: 4, name: "みどりの日" },
  { month: 5, day: 5, name: "こどもの日" },
  { month: 8, day: 11, name: "山の日" },
  { month: 11, day: 3, name: "文化の日" },
  { month: 11, day: 23, name: "勤労感謝の日" },
];

/** ハッピーマンデー祝日 */
function getHappyMondayHolidays(year: number): Holiday[] {
  return [
    { month: 1, day: nthMonday(year, 1, 2), name: "成人の日" },
    { month: 7, day: nthMonday(year, 7, 3), name: "海の日" },
    { month: 9, day: nthMonday(year, 9, 3), name: "敬老の日" },
    { month: 10, day: nthMonday(year, 10, 2), name: "スポーツの日" },
  ];
}

/** 春分の日（近似計算） */
function getVernalEquinoxDay(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 秋分の日（近似計算） */
function getAutumnalEquinoxDay(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 第n月曜日の日付を返す */
function nthMonday(year: number, month: number, n: number): number {
  const first = new Date(year, month - 1, 1);
  const dayOfWeek = first.getDay(); // 0=Sun ... 6=Sat
  const firstMonday = dayOfWeek <= 1 ? 1 + (1 - dayOfWeek) : 1 + (8 - dayOfWeek);
  return firstMonday + (n - 1) * 7;
}

/** 指定年のすべての祝日を取得（振替休日含む） */
function getAllHolidays(year: number): Set<string> {
  const holidays: { month: number; day: number }[] = [];

  // 固定祝日
  holidays.push(...FIXED_HOLIDAYS);

  // ハッピーマンデー
  holidays.push(...getHappyMondayHolidays(year));

  // 春分の日・秋分の日
  holidays.push({ month: 3, day: getVernalEquinoxDay(year) });
  holidays.push({ month: 9, day: getAutumnalEquinoxDay(year) });

  // キーをセットに変換
  const holidaySet = new Set<string>();
  for (const h of holidays) {
    holidaySet.add(`${year}-${h.month}-${h.day}`);
  }

  // 振替休日: 祝日が日曜の場合、翌営業日（月曜以降で祝日でない日）を振替休日とする
  for (const h of holidays) {
    const date = new Date(year, h.month - 1, h.day);
    if (date.getDay() === 0) {
      // 翌日から順に祝日でない日を探す
      let sub = new Date(date);
      do {
        sub.setDate(sub.getDate() + 1);
      } while (
        holidaySet.has(`${sub.getFullYear()}-${sub.getMonth() + 1}-${sub.getDate()}`)
      );
      holidaySet.add(`${sub.getFullYear()}-${sub.getMonth() + 1}-${sub.getDate()}`);
    }
  }

  // 国民の休日: 2つの祝日に挟まれた平日は休日
  const sortedDates = [...holidaySet]
    .map((k) => {
      const [y, m, d] = k.split("-").map(Number);
      return new Date(y, m - 1, d);
    })
    .sort((a, b) => a.getTime() - b.getTime());

  for (let i = 0; i < sortedDates.length - 1; i++) {
    const diff =
      (sortedDates[i + 1].getTime() - sortedDates[i].getTime()) /
      (1000 * 60 * 60 * 24);
    if (diff === 2) {
      const between = new Date(sortedDates[i]);
      between.setDate(between.getDate() + 1);
      if (between.getDay() !== 0 && between.getDay() !== 6) {
        holidaySet.add(
          `${between.getFullYear()}-${between.getMonth() + 1}-${between.getDate()}`,
        );
      }
    }
  }

  return holidaySet;
}

// キャッシュ（年単位）
const cache = new Map<number, Set<string>>();

/**
 * 指定日が日本の祝日かどうかを判定
 */
export function isJapaneseHoliday(date: Date): boolean {
  const jst = new Date(
    date.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }),
  );
  const year = jst.getFullYear();
  const month = jst.getMonth() + 1;
  const day = jst.getDate();

  if (!cache.has(year)) {
    cache.set(year, getAllHolidays(year));
  }

  return cache.get(year)!.has(`${year}-${month}-${day}`);
}

/**
 * 指定日が営業日（平日かつ祝日でない）かどうかを判定
 */
export function isBusinessDay(date: Date = new Date()): boolean {
  const jst = new Date(
    date.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }),
  );
  const dow = jst.getDay();
  if (dow === 0 || dow === 6) return false; // 土日
  return !isJapaneseHoliday(date);
}
