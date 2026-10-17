// 限定公開用パスワードのハッシュを作る（パスワード自体はどこにも保存しない）。
//   node tools/hash-password.mjs            … 対話入力（画面に表示しない）
//   出力された pbkdf2$... を `npx wrangler secret put KIVA_PASSWORD_HASH` に貼り付ける
import { hashPassword } from '../worker/index.js';

const WEAK = ['kiva2026', 'password', 'kiva', 'karate', 'seipai'];

async function readHidden(prompt) {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let s = '';
    for await (const c of stdin) s += c;
    return s.replace(/\r?\n$/, '');
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let s = '';
    stdin.on('data', function onData(ch) {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(s);
      } else if (ch === '\u0003') process.exit(1);
      else if (ch === '\u007f') s = s.slice(0, -1);
      else s += ch;
    });
  });
}

const pw = await readHidden('新しいパスワード（12文字以上）: ');
if (pw.length < 12 || WEAK.some((w) => pw.toLowerCase().includes(w))) {
  console.error('パスワードが弱すぎます（12文字以上、推測されやすい語を含めない）。');
  process.exit(1);
}
if (process.stdin.isTTY) {
  const again = await readHidden('確認のためもう一度: ');
  if (again !== pw) { console.error('一致しません。'); process.exit(1); }
}
console.log(await hashPassword(pw));
