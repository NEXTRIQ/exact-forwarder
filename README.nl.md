# exact-forwarder (Nederlands)

Stuurt inkoopfacturen uit een Gmail- of Google Workspace-mailbox automatisch door naar het scanadres van je
Exact Online-administratie. Dat gaat met vaste regels, zonder AI, zonder externe dienst en zonder te gokken.

Veel ondernemers sturen elke factuur met de hand door naar `…@inkoop.exactonline.nl`, of gebruiken een
mailfilter dat ook contracten, offertes, aanmaningen en phishing meestuurt. exact-forwarder stuurt alleen door
wat duidelijk een factuur is. Twijfelgevallen houdt hij tegen, met een korte reden. Dezelfde PDF verstuurt hij
nooit twee keer.

## Wat hij doet

- **Doorsturen:** een PDF-bijlage, een factuurwoord, een geslaagde SPF/DKIM/DMARC-controle en een bekende
  leverancier uit `senders.conf`. Een onbekende zakelijke afzender kan ook, als de factuur een nummer, een bedrag
  en jouw bedrijfsnaam bevat.
- **Ter controle melden:** contracten, offertes, polissen, aanmaningen, ID-documenten, loonstroken,
  niet-geverifieerde afzenders, persoonlijke mailadressen en PDF's die al eerder zijn doorgestuurd.
- **Stil overslaan:** nieuwsbrieven, cv's, brochures en bounces.

Je krijgt per factuur een melding per e-mail en/of Telegram, met leverancier, factuurnummer, datum, bedrag en,
bij twijfel, de reden.

## Veiligheid

- Hij verstuurt nooit dubbel. Na een onderbreking vraagt hij je om in Verzonden te kijken.
- Gaan er in één run ongewoon veel facturen door, dan verstuurt hij niets en krijg je een alarm.
- Hij verstuurt alleen naar de ingestelde Exact-adressen en naar je eigen meldingsmailbox.
- Op schijf staan geen onderwerpen, adressen of mailteksten.

## Aan de slag

Volg de stappen in de [Engelse README](README.md#installation-linux-systemd): eerst een droogloop
(`DRY_RUN=1`), dan `seed`, dan live. Alle instellingen staan in [`env.example`](env.example).

Licentie: MIT. Niet verbonden aan Exact. Gemaakt door [NEXTRIQ](https://nextriq.nl).
