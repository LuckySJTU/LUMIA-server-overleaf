import { writeFile } from 'node:fs/promises'
import QRCode from 'qrcode'

const message =
  '\u611f\u8c22\u652f\u6301\uff0c\u6c38\u8fdc\u4e0d\u6b7b\uff01'
const output = new URL(
  '../public/img/lumia-operations-support-qr.png',
  import.meta.url
)
const image = await QRCode.toBuffer(message, {
  type: 'png',
  errorCorrectionLevel: 'M',
  margin: 4,
  scale: 16,
})

await writeFile(output, image)
