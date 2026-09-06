export async function isAdminUser(sql, user) {
  if (!user?.id) return false;
  const rows = await sql`SELECT user_id FROM admin_users WHERE user_id = ${user.id}`;
  return rows.length > 0;
}
