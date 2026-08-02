# Reolink in Gladys

This integration brings your **Reolink** cameras into Gladys: the image on the dashboard, live video, detections as scene triggers, and control of the spotlight, the siren or the PTZ presets depending on the model.

Everything happens **on your local network**. No Reolink account is needed, and no image ever goes through a cloud.

## What you need

- One or more Reolink cameras on the same network as Gladys.
- The username and password you use to log into those cameras (the ones from the Reolink app, usually `admin`).

That is all. There is no account to create and no API key to request.

## Setup

1. In Gladys, open **Integrations → Install an integration** and install Reolink.
2. In the configuration screen, fill in the **username** and **password** of your cameras.
3. Click **Test the connection**: Gladys looks for your cameras and reports what each one can do.
4. Go to **Discover** and run a scan: your cameras appear there, ready to be added.

### If a camera is not found

Gladys looks for your cameras with a network broadcast. Some routers filter it, and a camera on another VLAN never receives it. In that case, enter its address under **Camera addresses**, in the Advanced section:

```
192.168.1.42, 192.168.1.43
```

If a camera does not use the standard port, add it: `192.168.1.42:8000`.

### If your cameras do not share the same password

Fill in the exceptions under **Accounts per camera**:

```
192.168.1.42|gladys|MyPassword
```

Cameras absent from that list use the global account.

## What you get

Each camera gets **the features it actually has**. The integration asks the camera rather than trusting its model name: two cameras of the same range can differ.

| Feature    | On which cameras              |
| ---------- | ----------------------------- |
| Image      | All                           |
| Live video | All                           |
| Motion     | All                           |
| Doorbell   | Video doorbells               |
| Battery    | Battery and solar models      |
| Spotlight  | Models with a white spotlight |
| Siren      | Models with an alarm speaker  |
| Infrared   | Most models                   |
| PTZ preset | Motorized cameras             |

### Detections

Reolink cameras keep no event log: they report their **current state**. Gladys therefore asks them regularly, and the check interval is also the detection delay. It defaults to 15 seconds; you can lower it to react faster, at the cost of questioning your cameras more often.

A detection also triggers an image capture, so the widget shows what happened without waiting.

> **Person / vehicle / animal detection.** Recent cameras tell these three apart, but Gladys cannot display them properly yet: they would show up as features with no name and no icon. They are therefore on hold, and will come back as soon as Gladys supports them. Motion detection itself works on every camera.

### PTZ presets

On a motorized camera, the "Preset" feature takes a **number** — the one of the position saved in the Reolink app. The **List the PTZ presets** action shows the available numbers for each camera.

In a scene, sending `2` to that feature moves the camera to preset 2.

## Battery protection

Capturing an image is what drains a battery or solar camera the most. The integration therefore backs off before the battery reaches a critical level:

- **below 60%**: the automatic refresh stops. Opening the widget or a detection still captures an image;
- **below 40%**: no image is captured at all;
- **back to normal** at a full charge, or as soon as the camera is put back on its charger.

The battery level and the detections keep being read in every case: they cost almost nothing, and they are what tells when the camera has recharged.

Both thresholds are configurable, and wired cameras are never affected.

## Frequently asked questions

**The dashboard image is frozen.**
Check the refresh interval in the Advanced section. If the camera runs on battery, it may be paused: look at its battery level.

**Live video does not start.**
Live goes through the camera RTSP stream. Check that RTSP is enabled in the camera settings (Reolink app → Settings → Advanced network → RTSP server).

**A camera was found but Gladys says the credentials are refused.**
The account used must be allowed to read the camera settings. A restricted user works, but a "guest" account does not always have the required rights.

**My spotlight switches itself off.**
The camera applies its own lighting schedule. The integration widens that schedule when you turn the spotlight on from Gladys, but a change made afterwards in the Reolink app takes over.

**My battery cameras connected to a Home Hub do not appear.**
This version handles standalone cameras. An NVR or a Home Hub exposes several cameras behind a single address, which is not supported yet.
