import assert from "node:assert/strict";
import test from "node:test";
import {
  consentAccepted,
  dailyCap,
  hkQuotaKeys,
  killSwitchEnabled,
  monthlyPlan,
  originAllowed,
  PAGES_ORIGIN,
} from "../src/quota.js";

test("US$15 brake stops at 80% of paid units", () => {
  const plan = monthlyPlan({
    MONTHLY_BUDGET_USD: "15",
    MONTHLY_STOP_FRACTION: "0.8",
    FREE_UNITS_PER_MONTH: "1000",
    PRICE_PER_THOUSAND_USD: "1.50",
  });
  assert.equal(plan.paidUnitsAtCap, 10000);
  assert.equal(plan.paidUnitsStop, 8000);
  assert.equal(plan.monthlyUnitLimit, 9000);
  assert.equal(plan.estimatedUsdAtStop, 12);
});

test("defaults match the locked budget", () => {
  const plan = monthlyPlan({});
  assert.equal(plan.monthlyUnitLimit, 9000);
  assert.equal(dailyCap({}), 50);
});

test("stop fraction cannot exceed the paid budget", () => {
  const plan = monthlyPlan({ MONTHLY_STOP_FRACTION: "5", MONTHLY_BUDGET_USD: "15" });
  assert.equal(plan.fraction, 1);
  assert.equal(plan.paidUnitsStop, 10000);
  assert.equal(plan.monthlyUnitLimit, 11000);
});

test("kill switch is off unless explicitly enabled", () => {
  assert.equal(killSwitchEnabled(undefined), false);
  assert.equal(killSwitchEnabled("false"), false);
  assert.equal(killSwitchEnabled(""), false);
  assert.equal(killSwitchEnabled("true"), true);
  assert.equal(killSwitchEnabled("on"), true);
  assert.equal(killSwitchEnabled("1"), true);
});

test("Hong Kong calendar keys", () => {
  const evening = hkQuotaKeys(new Date("2026-10-12T15:30:00Z"));
  assert.equal(evening.dayKey, "day:2026-10-12");
  const afterMidnight = hkQuotaKeys(new Date("2026-10-12T16:30:00Z"));
  assert.equal(afterMidnight.dayKey, "day:2026-10-13");
  assert.equal(afterMidnight.monthKey, "month:2026-10");
});

test("CORS origins are the Pages site and localhost only", () => {
  assert.equal(originAllowed("").ok, true);
  assert.equal(originAllowed(PAGES_ORIGIN).ok, true);
  assert.equal(originAllowed("http://localhost:8080").ok, true);
  assert.equal(originAllowed("http://127.0.0.1:5500").ok, true);
  assert.equal(originAllowed("https://example.com").ok, false);
  assert.equal(originAllowed("https://francischeung11240518.github.io.evil.test").ok, false);
});

test("JSON consent must be boolean true", () => {
  assert.equal(consentAccepted(true, "json"), true);
  assert.equal(consentAccepted("true", "json"), false);
  assert.equal(consentAccepted(1, "json"), false);
  assert.equal(consentAccepted("true", "multipart"), true);
  assert.equal(consentAccepted("yes", "multipart"), false);
});
