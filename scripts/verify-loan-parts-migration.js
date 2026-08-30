import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const calculationsPath = fileURLToPath(new URL("../calculations.js", import.meta.url));
vm.runInThisContext(fs.readFileSync(calculationsPath, "utf8"), { filename: calculationsPath });
const { normalizeLoan } = globalThis.LendpileCalculations;
const stable = value => JSON.stringify(value);
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function parseRows(raw) {
  return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

export function buildMigrationPlan(rows, { expectedRows = rows.length } = {}) {
  assert(Array.isArray(rows), "backup is not a row array");
  assert(rows.length === expectedRows, `expected exactly ${expectedRows} backup rows`);
  assert(new Set(rows.map(row => row.user_id)).size === rows.length, "backup contains duplicate users");

  let loanCount = 0;
  let partCount = 0;
  let adjustmentCount = 0;
  const entries = rows.map(row => {
    assert(typeof row.user_id === "string" && row.user_id, "backup row has no user id");
    const sourceData = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    assert(Array.isArray(sourceData), "row data is not a loan array");
    const converted = sourceData.map(loan => {
      loanCount += 1;
      const canonical = normalizeLoan(loan);
      const positive = (loan.loanChanges || []).filter(change => Number(change.amount) > 0);
      const nonPositive = (loan.loanChanges || []).filter(change => Number(change.amount) <= 0);
      assert(canonical.schemaVersion === 2, "schema version mismatch");
      assert(canonical.loanParts.length === positive.length + 1, "part count mismatch");
      assert(canonical.principalAdjustments.length === nonPositive.length, "adjustment count mismatch");
      assert(stable(canonical.payments || []) === stable(loan.payments || []), "payments changed");
      assert(stable(canonical.loanParts[0].interestChanges || []) === stable(loan.interestChanges || []), "primary rate history changed");
      assert(stable(normalizeLoan(canonical)) === stable(canonical), "normalization is not structurally idempotent");
      assert(!("initialAmount" in canonical) && !("loanChanges" in canonical) && !("interestRate" in canonical), "legacy authority retained");

      positive.forEach((change, index) => {
        const part = canonical.loanParts[index + 1];
        const effective = (loan.interestChanges || [])
          .filter(item => new Date(item.date) <= new Date(change.date))
          .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
        const expectedRate = Number(effective ? effective.rate : loan.interestRate);
        assert(Number(part.originalPrincipal) === Number(change.amount), "drawdown principal changed");
        assert(part.startDate === String(change.date).slice(0, 10), "drawdown date changed");
        assert(Number(part.interestRate) === expectedRate, "effective rate mismatch");
        const { amount: _legacyAmount, date: _legacyDate, ...auditFields } = change;
        Object.entries(auditFields).forEach(([key, value]) => {
          assert(stable(part[key]) === stable(value), `drawdown audit field changed: ${key}`);
        });
        assert(!("amount" in part), "canonical part retained legacy amount");
        assert(!("date" in part), "canonical part retained legacy date");
      });
      nonPositive.forEach((change, index) => {
        const adjustment = canonical.principalAdjustments[index];
        assert(Number(adjustment.amount) === Number(change.amount), "adjustment amount changed");
        assert(adjustment.date === String(change.date).slice(0, 10), "adjustment date changed");
        const { amount: _legacyAmount, date: _legacyDate, allocationPolicy: _legacyPolicy, ...auditFields } = change;
        Object.entries(auditFields).forEach(([key, value]) => {
          assert(stable(adjustment[key]) === stable(value), `adjustment audit field changed: ${key}`);
        });
        assert(adjustment.allocationPolicy === "proRata", "adjustment allocation policy mismatch");
      });
      partCount += canonical.loanParts.length;
      adjustmentCount += canonical.principalAdjustments.length;
      return canonical;
    });
    return { user_id: row.user_id, source: sourceData, converted };
  });

  return { expectedRows, entries, loanCount, partCount, adjustmentCount };
}

function dollarQuoted(value) {
  const body = JSON.stringify(value);
  const delimiter = `$lendpile_${sha256(body).slice(0, 16)}$`;
  assert(!body.includes(delimiter), "could not safely quote migration payload");
  return `${delimiter}${body}${delimiter}`;
}

export function buildGuardedMigrationSql(plan, { apply = false } = {}) {
  assert(plan.entries.length === plan.expectedRows, "migration plan row count mismatch");
  const payload = plan.entries.map(({ user_id, source, converted }) => ({ user_id, source, converted }));
  return `BEGIN;
CREATE TEMP TABLE lendpile_expected ON COMMIT DROP AS
SELECT user_id, source, converted
FROM jsonb_to_recordset(${dollarQuoted(payload)}::jsonb)
  AS item(user_id text, source jsonb, converted jsonb);
LOCK TABLE loan_data IN SHARE ROW EXCLUSIVE MODE;

DO $lendpile_guard$
DECLARE
  actual_rows integer;
  matched_rows integer;
  changed_rows integer;
BEGIN
  SELECT count(*) INTO actual_rows FROM loan_data;
  IF actual_rows <> ${plan.expectedRows} THEN
    RAISE EXCEPTION 'production scope changed: expected ${plan.expectedRows} rows';
  END IF;

  SELECT count(*) INTO matched_rows
  FROM loan_data current
  JOIN lendpile_expected expected USING (user_id)
  WHERE current.data = expected.source;
  IF matched_rows <> ${plan.expectedRows} THEN
    RAISE EXCEPTION 'source data drifted from the protected backup';
  END IF;

  UPDATE loan_data current
  SET data = expected.converted, updated_at = now()
  FROM lendpile_expected expected
  WHERE current.user_id = expected.user_id
    AND current.data = expected.source;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> ${plan.expectedRows} THEN
    RAISE EXCEPTION 'guarded update did not change every expected row';
  END IF;

  IF EXISTS (
    SELECT 1 FROM loan_data current
    JOIN lendpile_expected expected USING (user_id)
    WHERE current.data <> expected.converted
  ) THEN
    RAISE EXCEPTION 'transaction readback did not match canonical data';
  END IF;
END
$lendpile_guard$;
${apply ? "COMMIT;" : "ROLLBACK;"}
`;
}

export function buildMigrationReadbackSql(plan, { applied = false } = {}) {
  assert(plan.entries.length === plan.expectedRows, "migration plan row count mismatch");
  const payload = plan.entries.map(({ user_id, source, converted }) => ({
    user_id,
    target: applied ? converted : source
  }));
  return `WITH expected AS (
  SELECT user_id, target
  FROM jsonb_to_recordset(${dollarQuoted(payload)}::jsonb)
    AS item(user_id text, target jsonb)
)
SELECT CASE
  WHEN (SELECT count(*) FROM loan_data) = ${plan.expectedRows}
   AND (SELECT count(*) FROM loan_data current JOIN expected USING (user_id) WHERE current.data = expected.target) = ${plan.expectedRows}
  THEN 'PASS'
  ELSE 'FAIL'
END AS status;`;
}

function postgresEnvironment(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    assert(url.protocol === "postgres:" || url.protocol === "postgresql:", "invalid database URL");
    return {
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGSSLMODE: url.searchParams.get("sslmode") || "require"
    };
  } catch {
    throw new Error("invalid database URL");
  }
}

function runPsql(sql, databaseUrl) {
  const result = spawnSync("psql", ["--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    env: { ...process.env, ...postgresEnvironment(databaseUrl) }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || "psql migration failed").trim());
  return (result.stdout || "").trim();
}

function summary(plan, sourceRaw) {
  const converted = plan.entries.map(entry => JSON.stringify({ user_id: entry.user_id, data: entry.converted })).join("\n") + "\n";
  return {
    status: "PASS",
    rows: plan.entries.length,
    loans: plan.loanCount,
    loanParts: plan.partCount,
    principalAdjustments: plan.adjustmentCount,
    sourceSha256: sha256(sourceRaw),
    convertedSha256: sha256(converted)
  };
}

if (process.argv[1] && fileURLToPath(new URL(`file://${process.argv[1]}`)) === scriptPath) {
  const args = process.argv.slice(2);
  const inputPath = args.find(arg => !arg.startsWith("--"));
  const apply = args.includes("--apply");
  const databaseEnvArg = args.find(arg => arg.startsWith("--database-env="));
  if (!inputPath) {
    console.error("Usage: node scripts/verify-loan-parts-migration.js <backup.jsonl> [--database-env=NAME] [--apply]");
    process.exit(2);
  }
  if (apply && !databaseEnvArg) {
    console.error("--apply requires --database-env=NAME");
    process.exit(2);
  }

  const raw = fs.readFileSync(inputPath, "utf8");
  const rows = parseRows(raw);
  const plan = buildMigrationPlan(rows, { expectedRows: databaseEnvArg ? 2 : rows.length });
  let mode = "offline";
  if (databaseEnvArg) {
    const envName = databaseEnvArg.slice("--database-env=".length);
    const databaseUrl = process.env[envName];
    assert(databaseUrl, `missing database URL environment variable: ${envName}`);
    runPsql(buildGuardedMigrationSql(plan, { apply }), databaseUrl);
    const readback = runPsql(buildMigrationReadbackSql(plan, { applied: apply }), databaseUrl);
    assert(readback === "PASS", "post-transaction database readback failed");
    mode = apply ? "applied" : "database-dry-run";
  }
  console.log(JSON.stringify({ ...summary(plan, raw), mode }));
}
