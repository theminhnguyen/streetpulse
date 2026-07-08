# 🚦 StreetPulse

Eine kleine Web-App, die durch deine Webcam auf die Straße vor dem Fenster schaut
und automatisch mitzählt, was dort passiert: **Autos, Fußgänger, Fahrräder,
Motorräder/Roller, Busse, LKW, Hunde und Katzen** – inklusive einer groben
**Geschwindigkeits­schätzung** der Fahrzeuge.

> **Proof of Concept.** Läuft komplett **lokal im Browser** – es werden keine
> Bilder oder Daten hochgeladen, es gibt keinen Server.

## ✨ Funktionen

- **Live-Objekterkennung** per Webcam (oder aus einer geladenen Video-Datei)
- **Zählung** pro Kategorie: „jetzt im Bild" und „heute gesamt" – bleibt nach dem Neuladen erhalten
- **Zähllinie mit Richtung**: zählt Objekte beim Überqueren, getrennt nach Fahrtrichtung
- **Beobachtungs-Zone**: nur einen gewählten Bildbereich auswerten (z. B. nur die Straße)
- **Geschwindigkeits­schätzung** bewegter Fahrzeuge – grob per Schieberegler **oder präzise per 2-Punkt-Kalibrierung** (Strecke mit bekannter realer Länge), mit **Maßstab direkt im Bild**
- **Tempo-Statistik**: Durchschnitt, **85 %-Wert** (Standard der Verkehrsplanung), Spitze, Anteil über einem Tempolimit und ein Geschwindigkeits-Histogramm
- **Verlaufs-Diagramm** (letzte 60 s), **Tagesverlauf** (pro Stunde) und **mehrtägiger Verlauf** (bis zu 14 Tage)
- **Report als Bild (PNG)** mit allen Kennzahlen und Diagrammen – zum Teilen (z. B. mit Stadt/Nachbarschaft)
- **Alarm** bei bestimmten Objekten oder ab einem Tempo – mit Ton und automatischem **Schnappschuss**
- **Genauigkeits-Umschalter** (schnelles oder genaueres Erkennungsmodell)
- **Ereignis-Log** und **CSV-Export** (inklusive Richtung)
- **Automatische Pause**, wenn der Browser-Tab in den Hintergrund wechselt
- Einstellungen, Zone/Linie/Kalibrierung und mehrtägige Statistik werden lokal gespeichert (localStorage)

## 🚀 Nutzung

1. Die Seite in einem modernen Browser (Chrome/Edge/Firefox/Safari) öffnen.
2. **„Kamera starten"** klicken und den Kamerazugriff erlauben.
   - Alternativ **„Video laden"** und eine Videodatei mit Straßenverkehr wählen.
3. Kamera auf die Straße richten. Die Zählung beginnt automatisch.
4. Für bessere Geschwindigkeits­werte: Schieberegler **„Straßenbreite im Bild"**
   ungefähr auf die real sichtbare Breite (in Metern) einstellen – der Maßstab
   dazu wird direkt im Kamerabild angezeigt.
5. Optionale Werkzeuge über dem Bild:
   - **▦ Zone** ziehen, um nur einen Bereich auszuwerten.
   - **╱ Zähllinie** über die Straße ziehen, um Überquerungen nach Richtung zu zählen.
   - **📏 Kalibrieren** – eine Strecke mit bekannter Länge markieren (z. B. ein
     geparktes Auto ≈ 4,5 m) für belastbarere km/h-Werte.
   - **🔔 Alarm** einstellen, um bei bestimmten Objekten oder ab einem Tempo ein
     Ton-Signal und einen Schnappschuss auszulösen.
6. Über **📄 Report** ein teilbares Bild mit allen Zahlen und Diagrammen erzeugen.

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

*StreetPulse · Proof of Concept*
