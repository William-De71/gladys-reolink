import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatteryGuard, CAPTURE_POLICY, isCharging } from '../src/reolink/batteryGuard.js';
import { BATTERY_THRESHOLDS, BATTERY_READING_MAX_AGE_MS } from '../src/reolink/constants.js';

const ID = 'ext:ext-dev-reolink:camera:UID1';

test('isCharging covers both states that mean "on the charger"', () => {
  assert.equal(isCharging(1), true); // charging
  assert.equal(isCharging(2), true); // charge complete
  assert.equal(isCharging(0), false); // none
  assert.equal(isCharging(3), false); // low power
  assert.equal(isCharging(undefined), false);
});

test('a wired camera is never throttled', () => {
  // A wired camera reports no battery at all: guessing would stop capturing on
  // a camera that has nothing to protect. A BATTERY camera with no reading is a
  // different case entirely — see the on-demand test below.
  const guard = new BatteryGuard();
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.FULL);
  assert.equal(guard.levelOf(ID), null);
});

test('a healthy battery allows everything', () => {
  const guard = new BatteryGuard();
  guard.update(ID, { level: 85, chargeStatus: 0 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.FULL);
});

test('below the pause threshold only explicit captures survive', () => {
  const guard = new BatteryGuard();
  guard.update(ID, { level: 55, chargeStatus: 0 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);
  assert.equal(guard.allowsScheduled(ID), false);
  assert.equal(guard.allowsOnDemand(ID), true);
});

test('below the stop threshold nothing is captured at all', () => {
  const guard = new BatteryGuard();
  guard.update(ID, { level: 30, chargeStatus: 0 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.NONE);
  assert.equal(guard.allowsOnDemand(ID), false);
});

test('a camera that went low stays held back until properly recharged', () => {
  // Resuming early would restart the drain on a still-weak reserve, and repeated
  // shallow cycles wear the cell faster than one proper cycle.
  const guard = new BatteryGuard();
  guard.update(ID, { level: 45, chargeStatus: 0 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);

  guard.update(ID, { level: 70, chargeStatus: 0 });
  assert.equal(
    guard.policyFor(ID),
    CAPTURE_POLICY.ON_DEMAND,
    'still recovering above the pause threshold',
  );

  guard.update(ID, { level: BATTERY_THRESHOLDS.RESUME, chargeStatus: 0 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.FULL);
});

test('the resume level is reachable by a solar camera', () => {
  // Regression: it used to require a FULL charge. `chargeStatus` releases a
  // camera put back on its charger, so this level only ever applies to SOLAR
  // recharging — which charges in bursts and essentially never reads 100%. A
  // solar camera that dipped once stayed paused for good, with no charger to
  // put it on.
  assert.ok(
    BATTERY_THRESHOLDS.RESUME < 100,
    'requiring 100% makes the pause permanent on a solar camera',
  );
  assert.ok(
    BATTERY_THRESHOLDS.RESUME > BATTERY_THRESHOLDS.PAUSE_REFRESH,
    'resuming at the pause level would restart the drain immediately',
  );
});

test('the resume level can be set from the configuration', () => {
  const guard = new BatteryGuard();
  guard.configure({ battery_pause_refresh: 40, battery_stop_all: 20, battery_resume: 60 });
  guard.update(ID, { level: 35, chargeStatus: 0 });
  assert.equal(guard.allowsScheduled(ID), false);
  guard.update(ID, { level: 55, chargeStatus: 0 });
  assert.equal(guard.allowsScheduled(ID), false, 'below the configured resume level');
  guard.update(ID, { level: 60, chargeStatus: 0 });
  assert.equal(guard.allowsScheduled(ID), true);
});

test('a resume below the pause threshold is raised to it', () => {
  // Otherwise a camera would be released the moment it crossed back over the
  // pause limit, which is the shallow cycling the guard exists to prevent.
  const guard = new BatteryGuard();
  guard.configure({ battery_pause_refresh: 60, battery_resume: 30 });
  assert.ok(guard.resume >= guard.pauseRefresh);
});

test('a battery camera that never reported is held to on-demand', () => {
  // Regression: an unknown level used to mean "capture freely", which is exactly
  // backwards. A battery camera that does not answer is more likely to be flat
  // than fine, and the scheduled refresh is what would finish it off.
  const guard = new BatteryGuard();
  guard.trackBatteryCamera(ID);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);
  assert.equal(guard.allowsScheduled(ID), false);
  assert.equal(guard.allowsOnDemand(ID), true, 'the user can still ask for an image');
});

test('reporting a level marks a camera as running on battery', () => {
  const guard = new BatteryGuard();
  guard.update(ID, { level: 90, chargeStatus: 0 });
  assert.equal(guard.isBatteryCamera(ID), true);
});

test('a stale reading stops authorizing captures', (t) => {
  // The guard decides from the LAST known level, so a camera whose readings stop
  // coming would keep being captured against an ever-staler number — while the
  // battery it reflects keeps dropping.
  t.mock.timers.enable({ apis: ['Date'] });
  const guard = new BatteryGuard();
  guard.update(ID, { level: 95, chargeStatus: 0 });
  assert.equal(guard.allowsScheduled(ID), true);

  t.mock.timers.tick(BATTERY_READING_MAX_AGE_MS + 1000);
  assert.equal(guard.allowsScheduled(ID), false, 'a stale 95% must not keep the refresh running');
  assert.equal(guard.allowsOnDemand(ID), true);
});

test('a stale "charging" is not trusted either', (t) => {
  // The camera may have been taken off its charger hours ago: without a fresh
  // reading, "on the charger" is a claim about the past.
  t.mock.timers.enable({ apis: ['Date'] });
  const guard = new BatteryGuard();
  guard.update(ID, { level: 30, chargeStatus: 1 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.FULL);

  t.mock.timers.tick(BATTERY_READING_MAX_AGE_MS + 1000);
  assert.equal(guard.allowsScheduled(ID), false);
});

test('a fresh reading revives a camera whose level had gone stale', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const guard = new BatteryGuard();
  guard.update(ID, { level: 95, chargeStatus: 0 });
  t.mock.timers.tick(BATTERY_READING_MAX_AGE_MS + 1000);
  assert.equal(guard.allowsScheduled(ID), false);

  guard.update(ID, { level: 92, chargeStatus: 0 });
  assert.equal(guard.allowsScheduled(ID), true, 'the camera answered again');
});

test('a camera on its charger is released immediately', () => {
  // The cell is being refilled, which is exactly the state the threshold exists
  // to reach — holding the camera back would empty the dashboard for hours.
  const guard = new BatteryGuard();
  guard.update(ID, { level: 45, chargeStatus: 0 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);

  guard.update(ID, { level: 46, chargeStatus: 1 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.FULL);
});

test('a charging camera below the stop threshold still captures', () => {
  const guard = new BatteryGuard();
  guard.update(ID, { level: 20, chargeStatus: 1 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.FULL);
});

test('a camera taken off its charger while low goes back to being guarded', () => {
  const guard = new BatteryGuard();
  guard.update(ID, { level: 30, chargeStatus: 1 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.FULL);

  guard.update(ID, { level: 30, chargeStatus: 0 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.NONE);
});

test('configure applies the user thresholds', () => {
  const guard = new BatteryGuard();
  guard.configure({ battery_pause_refresh: 80, battery_stop_all: 50 });
  guard.update(ID, { level: 70, chargeStatus: 0 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.ON_DEMAND);
});

test('a stop threshold above the pause one is clamped', () => {
  // Otherwise the on-demand band would vanish and a camera would jump straight
  // from "everything" to "nothing".
  const guard = new BatteryGuard();
  guard.configure({ battery_pause_refresh: 50, battery_stop_all: 90 });
  assert.equal(guard.stopAll, 50);
});

test('an unreadable battery leaves the last decision untouched', () => {
  const guard = new BatteryGuard();
  guard.update(ID, { level: 30, chargeStatus: 0 });
  guard.update(ID, null);
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.NONE);
  assert.equal(guard.levelOf(ID), 30);
});
