import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatteryGuard, CAPTURE_POLICY, isCharging } from '../src/reolink/batteryGuard.js';

const ID = 'ext:ext-dev-reolink:camera:UID1';

test('isCharging covers both states that mean "on the charger"', () => {
  assert.equal(isCharging(1), true); // charging
  assert.equal(isCharging(2), true); // charge complete
  assert.equal(isCharging(0), false); // none
  assert.equal(isCharging(3), false); // low power
  assert.equal(isCharging(undefined), false);
});

test('a camera that was never read is never throttled', () => {
  // A wired camera reports no battery at all: guessing would stop capturing on
  // a camera that has nothing to protect.
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

test('a camera that went low stays held back until it is fully charged', () => {
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

  guard.update(ID, { level: 100, chargeStatus: 0 });
  assert.equal(guard.policyFor(ID), CAPTURE_POLICY.FULL);
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
