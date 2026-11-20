# Brewie Control protocol (recovered from app 1.1.15, verified on a ReBrewie 4.0.1 machine)

> Verified 2026-11-16 against a Brewie+ running ReBrewie software 4.0.1 / MCU firmware V7, using a live capture,
> the machine's own `BrewieApplication` binary, and its brewing logs.
>
> **Key behaviour:** while idle the machine sends **nothing**: no status lines, and no answer to `"?"`.
> Status (201) and the `"?"` reply only exist while a brew or cleaning program is active. Commands get no echo.

Source: `lib/armeabi-v7a/libBrewie.so` in `Brewie_Control_1.1.15.apk` (a Qt 5 / QML app), decompiled
from the `RemoteConnectionHandler`, `Brewing`, `MachineState`, `McuOutput` and `Recipe` classes.

## Transport

- TCP, port **8001** on the machine. The app is the client.
- Each frame is an `int32` big-endian byte length, followed by a `QDataStream` serialization of a
  `QMap<QString,QVariant>` with two keys:
  - `type` (`int`): the message type
  - `data` (`QVariant`): the payload
- QDataStream settings are Qt 5 defaults: big-endian and DoublePrecision. QVariants are written as
  `u32 typeId, u8 isNull, value`. QMap entries are written in reverse key order.
- There are no acknowledgements or sequence numbers. Queued messages are simply written in order.

## Pairing

| step | direction | message |
|---|---|---|
| 1 | app → machine | `{type:0, data:"brewie?"}` |
| 2 | machine → app | `{type:1, data:"hey"}` (any other reply = not a Brewie) |
| 3 | app → machine | `{type:200, data:"?"}` (ask for the running program) |
| 4 | app → machine | `{type:110, data:[removed recipe ids]}` (local deletions since the last sync) |

The app gives up if pairing doesn't finish within a timeout.

## Message types

| type | dir | data | meaning |
|---|---|---|---|
| 0 | → | `"brewie?"` | hello |
| 1 | ← | `"hey"` | hello reply |
| 100 | → | `QByteArray`: concatenated frames of `{id, time:qint64 ms, modified:bool}` | the app's recipe list |
| 101 | ↔ | recipe id | request a recipe |
| 102 | ↔ | `qCompress(QJsonDocument::toBinaryData(recipe))` | recipe body |
| 110 | ↔ | `QVariantList<QString>` | removed recipe ids. When the app receives this, it deletes those recipes and replies with 100. |
| 111 | ← | recipe id | remove one recipe |
| 200 | → | `"?"` query, `"200"` continue, `"201"` pause, `"204"` next step, `"999"` stop | command (the machine only acts on these while a program is active) |
| 200 | ← | `QByteArray` serialized Brewing | reply to `"?"`, **only when a program is active** |
| 201 | ← | MCU status line (tab separated) | live telemetry, **only while a program is active** |
| 300 | → | `{id, isWaterInlet:bool, isCooling:bool}` | start brewing a recipe that is on the machine |
| 300 | ← | `bool` | accepted? |
| 301 / 302 / 303 | → | `bool` | short clean / sanitizing clean / other cleaning type |
| 301–303 | ← | serialized Brewing, or empty if refused | |
| 304 | → | `{isBoilingTankActive, isMashingTankActive, isHopTankActive, sedimentation}` | drain |
| 304 | ← | `bool` | |
| 889 | ← | serial number | seen during network discovery |

## Serialized Brewing

`QDataStream(QMap{ id:QString, type:int, status:int, estimatedTime:int (s), isWaterInlet:bool, isCooling:bool,
data:QByteArray })`. Here `data` is `QDataStream(QList<QVariant>)` of **instructions**. Each instruction is a
list of 23 ints:

`[0] main step type, [1] inner step type, [2] index, … [6] mash target ×10 °C, [7] boil target ×10 °C, …
[18] duration s, [19] mode, …`

- Main step types: 0 preparation, 1 mashing, 2 sparging, 3 boiling/hopping, 4 cooling, 5 finishing.
- Inner step types seen in `createInstructions`: 10 water inlet, 12 heat to mash-in, 13 add grains,
  14 heat to step, 15 mash rest, 16 recirculation, 17/18 sparge, 19 heat to boil / boil, 21 hop-back,
  22 cooling, 24 finish, 26 next mash round.
- Brewing `type`: 0 brewing, 1 short clean, 2 sanitizing clean.
- Brewing `status`: 1 running, 2 paused, 4 stopped.

## MCU status line (type 201) — ReBrewie firmware V7, verified from brewing logs

`0 step · 1 total s · 2 step s · 3 step left s · 4 alerts+version ("P103,V7") · 5 mass raw · 6 water L ·
7 mash °C · 8 boil °C · 9 mash ×10 (shown on screen) · 10 boil ×10 · 11 mash pump tach · 12 boil pump tach ·
13 mash pump diag · 14 mash pump current · 15 boil pump diag · 16 boil pump current · 17 mash heater · 18 boil heater ·
19 board temp ×10 · 20 command echo · 21 flow total · 22 – · 23 sensor temp · 24 –`

Alert codes (from the flashed ReBrewie firmware): P103 confirm to continue, P998/P999 drain/power button,
E005 no inlet water, E006 cooling error, E007/E008 mash/boil heater fault, E009/E010 pump clogged, E011 no water,
E012 too much water, E115/E116 temp sensor lost, E118 level sensor, E20x valve x, E210 overcurrent,
E220/E221 pump dry, E300 bad step, E301/E302 program/step time limit.

### Older layout (from the stock app's parser / ReBrewie GitHub)

The fields are tab separated. The app requires more than 20 fields. Layout (matches the open ReBrewie firmware):

`0 step index (-1 idle) · 1 total s · 2 step s · 3 step left s · 4 notifications ("P103,V24,") · 5 mass ·
6 water L · 7 mash °C · 8 boil °C · 9 mash ×10 · 10 boil ×10 · 11/12 pump tach · 13 mash pump diag ·
14 mash pump A · 15 boil pump diag · 16 boil pump A · 17 mash heater · 18 boil heater · 19 board °C ·
20 command echo · 21 AC V · 22 mash flow · 23 boiling point · 24 mass temp · 25 boil flow · 26 AC A ×10`

`P103` means the machine is waiting for the user to confirm before it continues (answer with command `"204"`).

## Recipe JSON

Units: kg, L, °C, minutes.

Real recipes also use `customName` on fermentables and placeholder entries: `{amount}` in a bag, or `{time}`
in an empty hop cage (the cage time). `style` is
`{name, category, categoryNumber, styleLetter, ogMin, ogMax, fgMin, fgMax, abvMin, abvMax, ibuMin, ibuMax, colorMin, colorMax}`.
`fermentation` is optional and absent from all recipes on the test machine.

```
{ id, name, path:"/recipes/<id>", style, batchSize, efficiency, estOG, estFG, estABV, estColor(°L), IBU,
  fermentables: [[{name, amount, color, yield(ppg), mashable, category}]],     // per Brewie bag
  mash: { mashInWater, mashInTemperature, mashSteps:[[{stepTemp, stepTime}]],  // per mash round
          spargingWater?, spargingTemperature?, spargingTime? },
  hops: [[{name, amount, alpha, time}], [], [], []],                           // per hop cage
  delayedHoppingTime, coolingTemperature,
  fermentation: [{ ingredients:[{category:"yeast", attenuation, …}], … }] }
```

The machine rebuilds `path` from its last segment when it stores a recipe.

### Estimate formulas (`Recipe::calculate`)

- Efficiency by grain weight: `[0.9, 0.85, 0.8, 0.7, 0.65, 0.55, 0.5, 0.4][floor(kg)-1]`, or 0.65 above 8 kg.
- Volume (= `batchSize`): `V = (mashInWater + spargingWater − kg) × 0.9`.
- These formulas reproduce OG, IBU, colour, batch size and efficiency for all 25 recipes on the test machine.
- OG: `1 + Σ(eff·ppg·kg/0.45363) / (V/3.78541) / 1000`.
- Colour: `MCU = Σ(°L·kg/0.4536)/(V/3.78541)`, `SRM = 1.4922·MCU^0.6859`, `estColor = (SRM+0.76)/1.3546`.
- FG: `1 + round((OG−1)·1000)·(1−att/100)/1000`. ABV: `(OG−FG)·131`.
- IBU (Tinseth): `Σ α/100 · kg·10⁶ · (1−e^(−0.04t))/4.15 · 1.65·0.000125^(OG−1) / V`.
