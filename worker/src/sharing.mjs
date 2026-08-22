const VALID_PERMISSIONS = new Set(["view", "edit"]);
const VALID_RECIPIENT_VIEWS = new Set(["borrowing", "lending"]);

export function normalizeShareOptions(options = {}) {
  if (!VALID_PERMISSIONS.has(options.permission)) {
    throw new RangeError("Share permission must be 'view' or 'edit'.");
  }
  if (!VALID_RECIPIENT_VIEWS.has(options.recipientView)) {
    throw new RangeError("Share recipient role must be 'borrowing' or 'lending'.");
  }
  return {
    permission: options.permission,
    recipientView: options.recipientView,
    expiresInDays: Math.max(1, Number.parseInt(options.expiresInDays, 10) || 7),
  };
}

export function requireAppliedShareAction(action, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RangeError(`Share action '${action}' was not applied.`);
  }
  return rows[0];
}

export async function saveOwnerLoanData(sql, ownerId, loans) {
  const serializedLoans = JSON.stringify(Array.isArray(loans) ? loans : []);
  const rows = await sql`
    WITH saved AS (
      INSERT INTO loan_data (user_id, data, updated_at)
      VALUES (${ownerId}, ${serializedLoans}::jsonb, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
      RETURNING data, updated_at
    ), revoked AS (
      DELETE FROM loan_shares AS share
      USING saved
      WHERE share.owner_id = ${ownerId}
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(saved.data) AS current_loan
          WHERE current_loan->>'id' = share.loan_id
        )
      RETURNING share.id
    ), refreshed AS (
      UPDATE loan_shares AS share
      SET loan_snapshot = current_loan.loan
      FROM saved
      CROSS JOIN LATERAL jsonb_array_elements(saved.data) AS current_loan(loan)
      WHERE share.owner_id = ${ownerId}
        AND current_loan.loan->>'id' = share.loan_id
      RETURNING share.id
    )
    SELECT data, updated_at FROM saved
  `;
  return rows[0];
}

export async function updateSharedLoanAtomically(sql, token, recipientId, loan) {
  const serializedLoan = JSON.stringify(loan ?? null);
  const rows = await sql`
    WITH editable_share AS (
      SELECT owner_id, loan_id
      FROM loan_shares
      WHERE token = ${token}
        AND permission = 'edit'
        AND recipient_id = ${recipientId}
        AND used_at IS NOT NULL
        AND expires_at > NOW()
    ), owner_source AS MATERIALIZED (
      SELECT owner_data.user_id, owner_data.data, share.loan_id
      FROM loan_data AS owner_data
      JOIN editable_share AS share ON share.owner_id = owner_data.user_id
      FOR UPDATE OF owner_data
    ), rewritten AS (
      SELECT
        source.user_id,
        jsonb_agg(
          CASE WHEN item.loan->>'id' = source.loan_id
            THEN jsonb_set(${serializedLoan}::jsonb, '{id}', to_jsonb(source.loan_id), true)
            ELSE item.loan
          END
          ORDER BY item.ordinality
        ) AS data,
        count(*) FILTER (WHERE item.loan->>'id' = source.loan_id) AS matched
      FROM owner_source AS source
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(source.data) = 'array' THEN source.data ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS item(loan, ordinality)
      GROUP BY source.user_id
    ), saved AS (
      UPDATE loan_data AS owner_data
      SET data = rewritten.data, updated_at = NOW()
      FROM rewritten
      WHERE owner_data.user_id = rewritten.user_id
        AND rewritten.matched = 1
      RETURNING owner_data.user_id, owner_data.data
    ), refreshed AS (
      UPDATE loan_shares AS share
      SET loan_snapshot = current_loan.loan
      FROM saved
      CROSS JOIN LATERAL jsonb_array_elements(saved.data) AS current_loan(loan)
      WHERE share.owner_id = saved.user_id
        AND current_loan.loan->>'id' = share.loan_id
      RETURNING share.id
    )
    SELECT EXISTS (SELECT 1 FROM saved) AS ok
  `;
  return rows[0]?.ok === true;
}
