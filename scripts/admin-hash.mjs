import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

const hidden = new Writable({ write(_chunk, _encoding, done) { done(); } });
const input = createInterface({ input: process.stdin, output: hidden, terminal: Boolean(process.stdin.isTTY) });
if (process.stdin.isTTY) process.stderr.write('输入管理员密码（输入内容隐藏，按回车确认）：');
const [password] = await new Promise(resolve => {
  input.once('line', line => resolve([line]));
  input.once('close', () => resolve([]));
});
input.close();
if (process.stdin.isTTY) process.stderr.write('\n');

if (!password || password.length < 12 || password.length > 256) {
  console.error('请输入 12–256 字符的密码。');
  process.exitCode = 1;
} else {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64).toString('hex');
  console.log(`ADMIN_PASSWORD_HASH='scrypt$${salt}$${digest}'`);
}
