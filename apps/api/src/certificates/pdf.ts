import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

export interface CertificateContent {
  number: string;
  fullName: string;
  courseName: string;
  centreName: string;
  issuedAt: Date;
}

const scripts: [RegExp, string][] = [
  [/\p{Script=Devanagari}/u, 'NotoSansDevanagari'],
  [/\p{Script=Bengali}/u, 'NotoSansBengali'],
  [/\p{Script=Tamil}/u, 'NotoSansTamil'],
  [/\p{Script=Telugu}/u, 'NotoSansTelugu'],
  [/\p{Script=Gujarati}/u, 'NotoSansGujarati'],
  [/\p{Script=Kannada}/u, 'NotoSansKannada'],
  [/\p{Script=Malayalam}/u, 'NotoSansMalayalam'],
  [/\p{Script=Gurmukhi}/u, 'NotoSansGurmukhi'],
  [/\p{Script=Oriya}/u, 'NotoSansOriya'],
  [/\p{Script=Arabic}/u, 'NotoSansArabic'],
];

function fontFor(value: string) {
  const selected = scripts.find(([test]) => test.test(value))?.[1] ?? 'NotoSans';
  const installed = '/usr/share/fonts/truetype/noto/' + selected + '-Regular.ttf';
  const windows = join(process.env.WINDIR ?? 'C:/Windows', 'Fonts', 'arial.ttf');
  if (existsSync(installed)) return installed;
  return existsSync(windows) ? windows : 'Helvetica';
}

export async function renderCertificate(content: CertificateContent, origin: string): Promise<Buffer> {
  const url = new URL('/verify/' + content.number, origin).toString();
  const qr = await QRCode.toBuffer(url, { width: 280, errorCorrectionLevel: 'M' });
  const pdf = new PDFDocument({
    size: 'A4', layout: 'landscape', margin: 0,
    info: { Title: 'CertiFlow Certificate of Completion', CreationDate: content.issuedAt, ModDate: content.issuedAt },
  });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    pdf.rect(26, 26, 790, 543).lineWidth(2).stroke('#1d5144');
    pdf.font('Helvetica-Bold').fontSize(15).fillColor('#1d5144').text('PRAGATI SKILLS MISSION', 62, 70);
    pdf.fontSize(37).fillColor('#162b28').text('Certificate of Completion', 62, 109);
    pdf.moveTo(62, 159).lineTo(780, 159).lineWidth(1).stroke('#c0d6cc');

    function field(label: string, value: string, y: number, size: number) {
      pdf.font('Helvetica-Bold').fontSize(11).fillColor('#1d5144').text(label, 62, y);
      pdf.font(fontFor(value)).fontSize(size).fillColor('#162b28');
      while (size > 11 && pdf.heightOfString(value, { width: 510 }) > 49) pdf.fontSize(--size);
      pdf.text(value, 62, y + 18, { width: 510 });
    }

    field('Awarded to', content.fullName, 181, 29);
    field('Programme', content.courseName, 261, 21);
    field('Training centre', content.centreName, 334, 18);
    field('Issue date (UTC)', content.issuedAt.toISOString().slice(0, 10), 407, 16);
    field('Certificate number', content.number, 475, 14);

    pdf.image(qr, 600, 300, { width: 160 });
    pdf.font('Helvetica').fontSize(12).fillColor('#1d5144').text('Scan to verify this certificate', 583, 467, { width: 194, align: 'center' });
    pdf.link(600, 300, 160, 160, url);
    pdf.end();
  });
}
