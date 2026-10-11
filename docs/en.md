# Reolink in Gladys

This integration brings your **Reolink** cameras into Gladys: the image on the dashboard, live video, instant detections as scene triggers, and control of the spotlight, the siren, the infrared LEDs and the motorized heads depending on the model.

Everything happens **on your local network**. No Reolink account is needed, and no image ever goes through a cloud.

## What you need

- One or more Reolink cameras on the same network as Gladys — standalone, or paired with a **Home Hub** or an **NVR**.
- The username and password you use to log into those cameras (the ones from the Reolink app, usually `admin`).

That is all. There is no account to create and no API key to request.

> **Battery cameras** (Argus, Go…) are usually reached through their Home Hub or NVR: on their own, most of them do not offer the local API this integration uses.

## Setup

1. In Gladys, open **Integrations → Install an integration** and install Reolink.
2. In the configuration screen, fill in the **username** and **password** of your cameras.
3. Click **Test the connection**: Gladys looks for your cameras and reports what each one can do, whether it reports its detections instantly, and whether its live view is available.
4. Go to **Discover** and run a scan: your cameras appear there, ready to be added. Behind a Home Hub or an NVR, each camera becomes its own device.

### Recommended camera settings

Recent Reolink firmwares ship with some network services turned **off**. In the Reolink app, open **Settings → Network → Advanced → Server settings** (the wording varies slightly between app versions) and enable:

- **RTSP** — needed for the live video;
- **ONVIF** — needed for instant detections (see below).

The connection test tells you, camera by camera, when RTSP is off.

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

| Feature                   | On which cameras                           |
| ------------------------- | ------------------------------------------ |
| Image                     | All                                        |
| Live video                | All (RTSP enabled)                         |
| Motion                    | All                                        |
| Person / Vehicle / Animal | Models with AI detection                   |
| Doorbell                  | Video doorbells                            |
| Battery                   | Battery and solar models                   |
| Spotlight                 | Models with a white spotlight              |
| Siren                     | Models with an alarm speaker               |
| Infrared                  | Most models                                |
| Move (arrows)             | Motorized cameras (pan/tilt, or zoom only) |
| Preset                    | Motorized cameras with positions saved     |

### Detections

There are two ways a camera reports what it sees, and the integration picks the best one for each camera on its own:

- **Instantly, over ONVIF** — wired cameras reached directly **push** their motion, person, vehicle, animal and doorbell events the moment they happen, and say when they end. This is the default, as long as ONVIF is enabled on the camera.
- **By regular checks** — battery cameras, cameras behind a Home Hub or an NVR, and cameras with ONVIF turned off are asked regularly. The check interval (15 seconds by default) is then the detection delay.

If a camera stops answering over ONVIF, it falls back to regular checks by itself, and goes back to ONVIF as soon as it answers again. You can turn ONVIF off entirely with the **Instant detections (ONVIF)** option in the Advanced section.

A detection also triggers an image capture, so the widget shows what happened without waiting.

The person, vehicle and animal detections appear as motion sensors named "Person", "Vehicle" and "Animal": use them in a scene trigger like any motion sensor, for instance "when a person is detected at the gate, turn on the porch light".

### Doorbell

The doorbell button appears as a **Doorbell** feature: the dashboard shows "Ringing" during a ring, then the time of the last one, and the scene editor offers **"If the doorbell rings"**.

### Motorized cameras (PTZ)

- **Move** shows arrows on the dashboard. Each press moves the camera by one small step, which stops by itself — a scene sending a movement never leaves the camera turning. A camera with a zoom lens only gets the zoom buttons.
- **Preset** lists the positions saved in the Reolink app, by name. Pick one to move the camera there, from the dashboard or from a scene.

The list of positions is read when the camera is discovered: after saving a new position in the Reolink app, run a scan again. The **List the PTZ presets** action shows what each camera has saved right now.

## Battery protection

Capturing an image is what drains a battery or solar camera the most. The integration therefore backs off before the battery reaches a critical level:

- **below 60%**: the automatic refresh stops. Opening the widget or a detection still captures an image;
- **below 40%**: no image is captured at all;
- **back to normal** as soon as the camera is put back on its charger, or once it reaches **80%** on solar.

That 80% is deliberately well above the pause threshold: resuming just over it would restart the drain immediately. Avoid setting it to 100% — a solar camera charges in bursts and rarely reads exactly full, which would leave it paused for good with no charger to put it on.

The battery level and the detections keep being read in every case: they cost almost nothing, and they are what tells when the camera has recharged.

A battery camera that **stops answering** — deep sleep, refused session, network down — is also brought back to on-demand: its last known level can no longer be trusted, and a silent camera is more likely to be empty than fine.

Behind a Home Hub, the hub also tells which cameras are **asleep**: a sleeping camera is never woken up by the automatic refresh, whatever its level.

### A capture interval of their own

Battery cameras have their **own refresh interval**, independent of the wired ones. Spacing out the captures of a solar model therefore costs nothing to the freshness of your mains-powered cameras.

| Setting                         | Default       | Applies to           |
| ------------------------------- | ------------- | -------------------- |
| Image refresh interval          | 60s           | wired cameras only   |
| Battery camera refresh interval | 900s (15 min) | battery/solar models |

This is the single most effective setting: what costs the battery is **waking the camera up**, far more than the image itself. In winter, or if your panel gets little sun, lengthen that interval and raise the pause threshold.

Every threshold is configurable, and wired cameras are never affected.

## Frequently asked questions

**The dashboard image is frozen.**
Check the refresh interval in the Advanced section. If the camera runs on battery, it may be paused: look at its battery level.

**Live video does not start.**
Live goes through the camera RTSP stream. Run **Test the connection**: it says when RTSP is disabled on a camera. Enable it in the Reolink app (Settings → Network → Advanced → Server settings), then run a scan again.

**My detections arrive with a delay.**
The camera is checked regularly instead of pushing its events. Run **Test the connection**: a camera listed with "detections checked periodically" either runs on battery, sits behind a Home Hub or an NVR, or has ONVIF turned off. In the last case, enable ONVIF in the Reolink app and run a scan again.

**A camera was found but Gladys says the credentials are refused.**
The account used must be allowed to read the camera settings. A restricted user works, but a "guest" account does not always have the required rights.

**My spotlight switches itself off.**
The camera applies its own lighting schedule. When you turn the spotlight on from Gladys, the integration widens that schedule to the whole day, and puts your own settings back when you turn it off from Gladys. A change made in the Reolink app in between takes over.

**The Preset list is missing a position.**
The positions are read when the camera is discovered. Run a scan again after saving a new position in the Reolink app.

**A camera behind my Home Hub does not appear.**
The hub only lists the cameras it can currently reach. Check that the camera is powered and in range of the hub, then run a scan again.
