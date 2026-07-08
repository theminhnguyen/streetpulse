# 🪟 Fenster-Watch

Eine kleine Web-App, die durch deine Webcam auf die Straße vor dem Fenster schaut
und automatisch mitzählt, was dort passiert: **Autos, Fußgänger, Fahrräder,
Motorräder/Roller, Busse, LKW, Hunde und Katzen** – inklusive einer groben
**Geschwindigkeits­schätzung** der Fahrzeuge.

> **Proof of Concept.** Läuft komplett **lokal im Browser** – es werden keine
> Bilder oder Daten hochgeladen, es gibt keinen Server.

## ✨ Funktionen

- **Live-Objekterkennung** per Webcam (oder aus einer geladenen Video-Datei)
- **Zählung** pro Kategorie: „jetzt im Bild" und „gesamt seit Start"
- **Geschwindigkeits­schätzung** bewegter Fahrzeuge (grob, mit Kalibrierung)
- **Verlaufs-Diagramm** der letzten 60 Sekunden
- **Ereignis-Log** und **CSV-Export** der Beobachtungen
- **Automatische Pause**, wenn der Browser-Tab in den Hintergrund wechselt
- Erkennungs-Empfindlichkeit und Kalibrierung per Schieberegler einstellbar

## 🚀 Nutzung

1. Die Seite in einem modernen Browser (Chrome/Edge/Firefox/Safari) öffnen.
2. **„Kamera starten"** klicken und den Kamerazugriff erlauben.
   - Alternativ **„Video laden"** und eine Videodatei mit Straßenverkehr wählen.
3. Kamera auf die Straße richten. Die Zählung beginnt automatisch.
4. Für bessere Geschwindigkeits­werte: Schieberegler **„Straßenbreite im Bild"**
   ungefähr auf die real sichtbare Breite (in Metern) einstellen.

> Der Kamerazugriff im Browser funktioniert nur über **HTTPS** (oder `localhost`).
> Bei GitHub Pages ist HTTPS automatisch gegeben.

## 🔧 Technik

- **[TensorFlow.js](https://www.tensorflow.org/js)** mit dem Modell
  **COCO-SSD** (`lite_mobilenet_v2`) – erkennt 80 Objektklassen, wir nutzen die
  verkehrsrelevanten.
- Reine **Client-Side-App** (HTML/CSS/JS, keine Build-Tools, keine Abhängigkeiten
  außer den beiden CDN-Skripten).
- Eigener, schlanker **Objekt-Tracker** (`js/tracker.js`) für eindeutiges Zählen
  und die Bewegungs-/Geschwindigkeits­schätzung.

## ⚠️ Grenzen (bitte beachten)

- **Geschwindigkeit** ist nur eine **grobe Schätzung**. Sie hängt stark vom
  Kamerawinkel und der Kalibrierung ab und ersetzt keine echte Messung.
- **Tretroller / E-Scooter** haben keine eigene Modell-Klasse – sie werden meist
  als „Person" oder gar nicht erkannt. Motor*roller* zählen als „Motorrad".
- Genauigkeit hängt von **Licht, Abstand und Blickwinkel** ab. Bei Dunkelheit,
  Regen oder sehr dichtem Verkehr sinkt die Trefferquote.
- Die Gesamt-Zählung kann bei Verdeckungen gelegentlich doppelt zählen oder etwas
  übersehen.

## 🔒 Datenschutz

Das Kamerabild verlässt niemals deinen Rechner. Die gesamte Erkennung passiert
lokal im Browser. Es werden keine Daten gespeichert oder übertragen (außer dem
einmaligen Laden des KI-Modells über das CDN).

---

*Fenster-Watch · Proof of Concept*
