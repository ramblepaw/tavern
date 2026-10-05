// Usage: npm run reset-password -- <username> <new password>
import { db } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('Usage: npm run reset-password -- <username> <new password (8+ chars)>');
  process.exit(1);
}
const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No user named "${username}".`);
  process.exit(1);
}
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`Password updated for ${username}. They have been signed out everywhere.`);
