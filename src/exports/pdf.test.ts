import { describe, expect, it } from 'vitest';
import { HebrewPdf } from './pdf';

describe('Hebrew RTL PDF generation', () => {
  it('produces a valid PDF byte stream with the embedded Hebrew font', async () => {
    const pdf = new HebrewPdf();
    pdf.header('תקלה 2026-001', 'משתמש בדיקה');
    pdf.sectionTitle('פרטי פתיחה');
    pdf.field('מערכת / עמדה', 'מערכת אלפא');
    pdf.paragraph('תיאור עם טקסט מעורב: E-401, מספרים 123, וסימני פיסוק (בדיקה).');
    const blob = pdf.blob();
    expect(blob.size).toBeGreaterThan(0);
    const buf = new Uint8Array(pdf.doc.output('arraybuffer') as ArrayBuffer);
    const header = String.fromCharCode(...buf.slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  it('paginates long content without throwing', () => {
    const pdf = new HebrewPdf();
    pdf.header('תקלה ארוכה', 'משתמש בדיקה');
    for (let i = 0; i < 60; i++) {
      pdf.field(`שדה ${i}`, 'ערך לדוגמה עם טקסט בעברית ותוכן ארוך יחסית לבדיקת גלישה בין עמודים');
    }
    expect(() => pdf.blob()).not.toThrow();
  });

  it('renders mixed Hebrew/English/number text via splitTextToSize without error', () => {
    const pdf = new HebrewPdf();
    pdf.header('בדיקה', 'בודק');
    expect(() =>
      pdf.paragraph(
        'מערכת Alpha-1 דיווחה קוד שגיאה E-401 בשעה 13:46, עם ערכים (12.3%) ותווים מיוחדים: /\\&.',
      ),
    ).not.toThrow();
  });
});
