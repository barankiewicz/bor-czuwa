import { PDFDocument, PageSizes } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { NoticeParts, NoticeRecipient } from './notice-composer';
import { handoffNotice, handoffText } from './demo-handoff.js';

export async function noticePdf(recipient: NoticeRecipient, notice: NoticeParts): Promise<Blob> {
  notice = handoffNotice(notice);
  const response = await fetch('/fonts/NotoSans-Regular.ttf');
  if (!response.ok) throw new Error('pdf_font_unavailable');
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = await document.embedFont(await response.arrayBuffer(), { subset: true });
  const text = `${handoffText(recipient.name)}\n\n${notice.subject}\n\n${notice.body}`;
  const supported = new Set(font.getCharacterSet());
  if ([...text].some(character => !/\s/u.test(character) && !supported.has(character.codePointAt(0)!))) {
    throw new Error('pdf_unsupported_character');
  }
  document.setTitle(notice.subject);
  document.setLanguage('pl-PL');
  const margin = 50, size = 11, lineHeight = 16;
  let page = document.addPage(PageSizes.A4);
  let y = page.getHeight() - margin;
  const width = page.getWidth() - margin * 2;
  function line(text: string) {
    if (y < margin) { page = document.addPage(PageSizes.A4); y = page.getHeight() - margin; }
    if (text) page.drawText(text, { x: margin, y, size, font });
    y -= lineHeight;
  }
  for (const paragraph of text.split(/\r?\n/)) {
    let current = '';
    for (const word of paragraph.split(/\s+/u)) {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { current = next; continue; }
      if (current) { line(current); current = ''; }
      // Long URLs and words must fit the page too.
      for (const character of word) {
        if (font.widthOfTextAtSize(current + character, size) > width) { line(current); current = ''; }
        current += character;
      }
    }
    line(current);
  }
  return new Blob([new Uint8Array(await document.save())], { type: 'application/pdf' });
}
