/**
 * Wilnu Taxi — boekingsformulier widget (eerste aanzet)
 *
 * Losstaand, vanilla JS (geen build-stap, geen dependencies) — bedoeld om
 * op een WordPress/Elementor-pagina ingesloten te worden via een Custom
 * HTML-blok of shortcode, zoals afgesproken in het startdocument
 * ("Platform en huisstijl: WordPress met Elementor", "Gekozen architectuur:
 * hybride"). De widget praat op de achtergrond (fetch, geen navigatie, geen
 * iframe) met de losse backend voor configuratie, prijzen en boekingen.
 *
 * Gebruik (zie ook demo.html):
 *   <div data-wnt-widget data-api-base="https://boekingen-api.wilnutaxi.nl"></div>
 *   <script src="widget.js" defer></script>
 *
 * Wat deze eerste versie WEL doet:
 * - Adresvelden met POI-snelkeuze (voor het typen) EN echte, live
 *   Google-adressuggesties tijdens het typen (via GET
 *   /api/places-autocomplete — de Google-sleutel blijft aan de serverkant),
 *   zoals de huidige proefversie ook al doet. Een adres moet uit de lijst
 *   gekozen worden (of exact overeenkomen met een suggestie) voordat er
 *   verder gegaan kan worden — typt iemand toch door en drukt op verder,
 *   dan volgt een duidelijke melding die uitlegt wát er moet gebeuren (zie
 *   `renderAddressField`/`isFieldConfirmed`), in plaats van de te summiere
 *   melding van het huidige systeem (feedback Hans, 18 augustus 2026).
 *   Werkt de adressuggestie-service niet (bv. Places API niet ingeschakeld,
 *   zie placesAutocomplete.js), dan valt de widget terug op vrije tekst
 *   mét een zichtbare melding, in plaats van de klant helemaal vast te
 *   zetten.
 * - Richting (heen/terug) wordt automatisch afgeleid uit welk veld een
 *   herkende POI bevat, niet apart gevraagd.
 * - Datum/tijd standaard op "nu + 24u10min", met de gekozen datum/tijd
 *   altijd goed zichtbaar (tegen het per-ongeluk-verkeerde-dag-boeken).
 * - Bagage-invoer volledig config-gedreven (haalt bagagetypen/bijzondere
 *   bagage-opties op via GET /api/config — niks hardgecodeerd).
 * - Prijzen ophalen (POST /api/price), voertuigen die niet passen worden
 *   grijs getoond, niet verborgen (met reden erbij).
 * - Boeken (POST /api/book), met een bevestigingsscherm inclusief
 *   track-and-trace-link.
 *
 * Sinds 3 oktober 2026: de zone-herkenning van een vrij getypt adres
 * gebeurt niet meer via een komma-gok, en een letterlijk getypt POI-adres
 * levert nu de startdocument-bevestigingsvraag op ("Bedoelt u Eindhoven
 * Airport?") — zie resolveAddressZoneAndPoiMatch hieronder en
 * src/maps/resolveAddress.js in de backend. `guessZoneFromAddress` bestaat
 * nog, puur als stille terugval zodra die aanroep een keer niet lukt.
 *
 * Online betalen (8 oktober 2026): staat dat in de backend aan (/api/config
 * -> onlinePayment.enabled), dan stuurt "Bevestig en betaal" de klant naar de
 * MultiSafepay-betaalpagina en komt de klant terug op dezelfde pagina met
 * ?wnt_order=...; de widget toont dan de status (GET /api/booking-status) en
 * daarna de bevestiging. Staat het uit, dan gaat de rit direct naar taxiID.
 *
 * Wat bewust nog NIET (goed) zit — zie widget/README.md voor de volledige
 * lijst: huisstijl-afstemming met de echte Elementor-pagina (nu een neutrale
 * eigen stijl via CSS-variabelen).
 */
(function () {
  "use strict";

  function euro(amount) {
    return new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);
  }

  // "K7M3QX9P" -> "K7M3-QX9P" (alleen om te tonen)
  function formatDiscountCode(code) {
    const c = String(code || "").toUpperCase();
    return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
  }

  function formatDateTime(date) {
    return new Intl.DateTimeFormat("nl-NL", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  // Voor <input type="datetime-local">, dat een lokale tijd zonder
  // tijdzone-aanduiding verwacht (YYYY-MM-DDTHH:mm).
  function toDateTimeLocalValue(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  }

  // datetime-local geeft een string zonder tijdzone terug; we interpreteren
  // die als lokale tijd van de browser (voor Wilnu Taxi's klanten vrijwel
  // altijd Europe/Amsterdam) en zetten er zelf een offset bij, zodat het
  // een geldige ISO-string-met-offset wordt zoals de backend verwacht
  // (zie priceRequestSchema/bookRequestSchema: z.string().datetime({offset:true})).
  function localInputValueToDate(value) {
    // new Date("YYYY-MM-DDTHH:mm") interpreteert dit al als lokale tijd in
    // de browser — dat is precies wat we willen.
    return new Date(value);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach((key) => {
      if (key === "class") node.className = attrs[key];
      else if (key === "text") node.textContent = attrs[key];
      else if (key === "html") node.innerHTML = attrs[key];
      else if (key.startsWith("on") && typeof attrs[key] === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
      } else if (attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== false) {
        node.setAttribute(key, attrs[key] === true ? "" : attrs[key]);
      }
    });
    (children || []).forEach((child) => {
      if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  // Best-effort gok naar de "zone" (woonplaats/regio) uit een vrij
  // getypt adres, voor het matchen tegen vaste POI-tarieven. Dit is het
  // openstaande punt uit het startdocument ("Openstaand: hoe een ingetypt
  // huisadres tot een zone leidt") — hier tijdelijk opgelost door de
  // plaatsnaam uit het adres te gokken (meestal het één-na-laatste,
  // door komma's gescheiden onderdeel, bv. "Vincent van Goghstraat 1,
  // Nuenen, Nederland" -> "Nuenen"). Klopt de gok niet, dan vindt de
  // backend simpelweg geen vast tarief en valt automatisch terug op het
  // metertarief — er gaat dus nooit een verkeerde vaste prijs uit.
  function guessZoneFromAddress(address) {
    const parts = address
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) return null;
    return parts[parts.length - 2];
  }

  function createWidget(root) {
    const apiBase = (root.dataset.apiBase || "").replace(/\/$/, "");
    // Algemene voorwaarden en privacy statement (14 oktober 2026). Standaard de
    // pagina's op wilnutaxi.nl; te overschrijven met data-terms-url en
    // data-privacy-url op het widget-element.
    const termsUrl = root.dataset.termsUrl || "https://wilnutaxi.nl/algemene-voorwaarden/";
    const privacyUrl = root.dataset.privacyUrl || "https://wilnutaxi.nl/privacy-policy/";
    if (!apiBase) {
      root.appendChild(
        el("p", { class: "wnt-error" }, ["Configuratiefout: data-api-base ontbreekt op de widget-container."])
      );
      return;
    }

    const defaultLeadMinutesFallback = 1450; // 24u10min, zie startdocument — fallback totdat /api/config geladen is.

    const state = {
      step: "loading",
      config: null,
      loadError: null,
      // confirmed: true zodra het adres via een klik op een suggestie (POI
      // of Google Places) is gekozen, of exact met zo'n suggestie
      // overeenkomt. Zolang dat niet zo is, mag de klant niet verder — zie
      // isFieldConfirmed/renderAddressField.
      // zone/poiConfirmPending: zie resolveAddressZoneAndPoiMatch hieronder
      // (3 oktober 2026) -- de vervanging van de komma-gok door Google's
      // eigen locatiedata, en de geocoding-bevestigingsvraag uit het
      // startdocument ("Bedoelt u Eindhoven Airport?"). `zone` is de via
      // GET /api/resolve-address herkende plaatsnaam voor dit adres (null
      // zolang die nog niet (succesvol) is opgevraagd -- dan valt
      // resolveZone terug op de oude komma-gok). `poiConfirmPending` is
      // gezet zodra dat adres in de praktijk hetzelfde blijkt te zijn als
      // een bekende POI die niet via naam/snelkeuze gekozen is; de klant
      // moet dat eerst bevestigen of afwijzen (zie renderAddressField).
      origin: { text: "", poiId: null, confirmed: false, zone: null, poiConfirmPending: null },
      destination: { text: "", poiId: null, confirmed: false, zone: null, poiConfirmPending: null },
      // Wordt true zodra een aanroep naar /api/places-autocomplete is
      // mislukt (bv. Places API niet ingeschakeld voor de sleutel) — dan
      // laten we vrije tekst wél toe, met een zichtbare melding, in plaats
      // van de klant vast te zetten op een kapotte functie.
      placesUnavailable: false,
      // dateTime/dateTimeTouched: zolang de klant het veld niet zelf heeft
      // aangepast, wordt het moment ELKE keer opnieuw berekend als "nu +
      // voorsprongstijd" (zie getEffectiveDateTime hieronder), in plaats
      // van één keer bij het laden van de widget vastgezet. Zou het maar
      // één keer vastgezet worden, dan zakt de berekende tijd door het
      // eigen gewicht onder de 24u10min-grens zodra de klant een paar
      // minuten bezig is met het formulier — met een onterechte
      // "binnen 24 uur"-waarschuwing tot gevolg bij het boeken.
      dateTime: null,
      dateTimeTouched: false,
      // ⓘ bij "Gekozen moment" uitgeklapt? (stap 1)
      dateInfoOpen: false,
      arrivalInfoOpen: false,
      passengerCount: 1,
      childCount: 0,
      // hasBaggage: gevraagd op het eerste scherm (Hans, 19 augustus 2026,
      // na zijn eigen eerste test). Standaard `true` (dus standaard nog
      // steeds de bagage-stap tonen, zoals nu al) totdat de klant expliciet
      // "Nee" kiest — dan wordt de hele bagage-stap overgeslagen (zie
      // renderRideStep hieronder), want baggageCounts/specialBaggageId
      // blijven dan gewoon op hun neutrale standaardwaarde (leeg/"geen"),
      // wat precies "geen bagage" betekent voor de bagagecheck op de server.
      hasBaggage: true,
      baggageCounts: {},
      specialBaggageId: "geen",
      airportBaggageAnswer: null,
      // 2 oktober 2026 (Hans): vluchtnummer, gevraagd zodra de rit op een
      // luchthaven BEGINT (dus een aankomende passagier die wordt
      // opgehaald, zie isAirportPickup hieronder) -- zodat de
      // chauffeur/planning de vlucht kan volgen (vertraging, geland, etc.).
      // Los van `note` omdat taxiID's eigen Ride-schema hier een
      // toegewijd veld voor heeft (`flightNumber`, zie taxiidClient.js
      // backend-kant), geen vrije tekst.
      flightNumber: "",
      // 5 oktober 2026: resultaat van de vluchtopzoeking (GET
      // /api/flight-lookup), { key, status, flights } -- alleen informatief.
      flightInfo: null,
      // 5 oktober 2026 (Hans): geplande landingstijd die de passagier zelf
      // invult ("HH:MM") als de opzoeking er geen kon geven.
      flightManualLanding: "",
      flightManualOpen: false,
      // 6 oktober 2026 (Hans): vastlegging van elke keer dat de ophaaltijd
      // NIET door de klant zelf in het datumveld is gekozen, maar via een
      // knop is overgenomen ("Kies dit tijdstip" bij een volle categorie, of
      // "Ophaaltijd aanpassen aan de landing"). Elke stap: { reason, from,
      // to } (ISO). Gaat bij het boeken mee zodat de rit bij taxiID een
      // duidelijke melding krijgt (voorkomt latere discussies). Zodra de
      // klant daarna zelf het datumveld wijzigt, wordt de lijst leeggemaakt.
      timeSteps: [],
      // 12 oktober 2026: retourrit in dezelfde boeking. De terugrit gebruikt de
      // omgekeerde adressen en dezelfde passagiers, bagage en voertuigcategorie;
      // de klant kiest alleen datum en tijd (verplicht), en bij een terugrit
      // die op een luchthaven begint ook het vluchtnummer van de terugvlucht.
      // `returnTimeSteps`: zoals timeSteps, voor een via "Kies dit tijdstip"
      // overgenomen tijd van de terugrit.
      roundTrip: false,
      returnDateTime: null,
      returnFlightNumber: "",
      // Vluchtopzoeking en zelf ingevulde landingstijd van de terugvlucht
      // (zelfde werking als flightInfo/flightManualLanding hierboven).
      returnFlightInfo: null,
      returnFlightManualLanding: "",
      returnFlightManualOpen: false,
      // Meldingen bij velden (14 oktober 2026): sleutel -> { message, check? }.
      fieldErrors: {},
      // Akkoord met de algemene voorwaarden en het privacy statement.
      termsAccepted: false,
      returnTimeSteps: [],
      note: "",
      priceResult: null,
      priceError: null,
      selectedVehicleId: null,
      // 11 oktober 2026: persoonlijke kortingscode (zie renderDiscountBox).
      // `discountInput` is wat de klant typt, `discountCode` de code die met
      // de prijsaanvraag meegaat (pas na "Toepassen"), `discountApplied` het
      // door de server bevestigde antwoord { code, kind, value }.
      discountInput: "",
      discountCode: "",
      discountOpen: false,
      discountApplied: null,
      discountError: null,
      passenger: { firstName: "", lastName: "", email: "", phoneNumber: "" },
      bookResult: null,
      bookError: null,
      submitting: false,
      // Terugkeer van de betaalpagina (online betalen), zie startPaymentReturn.
      payment: null,
    };

    function findPoiById(id) {
      return (state.config.pois || []).find((p) => p.id === id) || null;
    }

    // Bepaalt de zone (woonplaats/regio) van een adresveld, voor het
    // werkgebied en het per-plaats minimumtarief. Is dit veld via een
    // snelkeuze (POI) ingevuld, dan gebruiken we bij voorkeur de eigen,
    // beheerde zone van die POI (bv. Eindhoven Airport -> "Eindhoven") --
    // 20 augustus 2026, naar aanleiding van Hans: "Eindhoven airport wordt
    // niet herkend als locatie binnen ons werkgebied". Reden: een via een
    // snelkeuze ingevulde tekst ("Eindhoven Airport") bevat geen komma's,
    // dus guessZoneFromAddress (die een "Straat, Plaats, Land"-adres
    // verwacht) gaf daar altijd `null` terug. Heeft de POI zelf nog geen
    // zone ingesteld, of is het veld niet via een POI ingevuld, dan valt dit
    // gewoon terug op dezelfde tekst-gok als voorheen. NB: dit raakt bewust
    // niet aan fixedRouteZone in determineRideMeta hieronder -- dat is de
    // zone van de ANDERE kant van de rit (de woonplaats van de klant), niet
    // van de POI zelf.
    function resolveZone(field) {
      if (field.poiId) {
        const poi = findPoiById(field.poiId);
        if (poi && poi.zone) return poi.zone;
      }
      // field.zone: de via GET /api/resolve-address herkende, echte
      // plaatsnaam (zie resolveAddressZoneAndPoiMatch hieronder, 3 oktober
      // 2026) -- vervangt hier de komma-gok zodra die bekend is. Is die
      // aanroep (nog) niet gelukt (storing, of nog niet afgerond), dan valt
      // dit terug op de oude gok -- fail-safe, nooit erger dan voorheen.
      if (field.zone) return field.zone;
      return guessZoneFromAddress(field.text);
    }

    function getDefaultLeadMinutes() {
      return (state.config && state.config.advanceBookingRule && state.config.advanceBookingRule.defaultLeadTimeMinutes) || defaultLeadMinutesFallback;
    }

    // Extra marge (in minuten) bovenop de backend's eigen 24u10min-drempel,
    // puur aan de widget-kant. Zonder deze marge zou het standaard-moment
    // exact ÓP de drempel liggen: de tijd die verstrijkt tussen het
    // berekenen van "nu" in de browser en het evalueren van "nu" op de
    // server (netwerklatentie, verwerkingstijd — al is dat maar een paar
    // milliseconden) duwt dat moment dan altijd net over de grens, met een
    // onterechte "binnen 24 uur"-waarschuwing tot gevolg. Deze marge lost
    // dat structureel op, net zoals je bij het vergelijken van kommagetallen
    // nooit exact op de grens vergelijkt.
    const widgetSafetyBufferMinutes = 5;

    // Het daadwerkelijk te gebruiken ophaalmoment. Heeft de klant het veld
    // niet zelf aangepast, dan wordt dit bij elke aanroep vers berekend
    // (zie toelichting bij state.dateTime hierboven) — dus altijd "nu +
    // voorsprongstijd (+ marge)" op het moment van bevragen, nooit een
    // verouderd, bij het laden van de widget bevroren moment.
    function getEffectiveDateTime() {
      if (state.dateTimeTouched && state.dateTime) return state.dateTime;
      return new Date(Date.now() + (getDefaultLeadMinutes() + widgetSafetyBufferMinutes) * 60 * 1000);
    }

    // Woorden die voor de klant hetzelfde betekenen. Een zoekterm van minimaal
    // drie tekens die (een deel van) een van deze woorden is, zoekt ook op de
    // andere woorden uit dezelfde rij.
    const SEARCH_SYNONYMS = [
      ["vliegveld", "luchthaven", "airport", "vlieghaven"],
      ["ziekenhuis", "hospital", "kliniek"],
      ["station", "treinstation"],
      ["cruise", "cruiseterminal", "cruisehaven"],
    ];

    function poiMatchesQuery(poi, query) {
      const needle = String(query || "").trim().toLowerCase();
      if (!needle) return true;
      const variants = [needle];
      if (needle.length >= 3) {
        SEARCH_SYNONYMS.forEach((group) => {
          if (group.some((word) => word.includes(needle))) variants.push(...group);
        });
      }
      const haystack = `${poi.name} ${poi.category || ""}`.toLowerCase();
      return variants.some((v) => haystack.includes(v));
    }

    function matchPoiByText(text) {
      const needle = text.trim().toLowerCase();
      if (!needle) return null;
      return (
        (state.config.pois || []).find(
          (p) => p.name.toLowerCase() === needle || p.address.toLowerCase() === needle
        ) || null
      );
    }

    // Een veld mag alleen verder gebruikt worden (naar de volgende stap, of
    // om te boeken) als het adres via een suggestie bevestigd is, óf als de
    // suggestieservice niet beschikbaar bleek (dan kunnen we niet meer
    // eisen dan vrije tekst). Zie Hans' feedback (18 augustus 2026): dit
    // vervangt het te simpel foutmeldingen geven bij een niet-gekozen adres.
    function isFieldConfirmed(field) {
      return field.confirmed || state.placesUnavailable;
    }

    // Haalt live adressuggesties op bij de backend (die op zijn beurt
    // Google Places aanroept, zie placesRoute.js). Puur de aanroep zelf —
    // de debounce (om niet bij elke toetsaanslag een aanvraag te doen) zit
    // per veld in renderAddressField, zodat het ophaaladres- en
    // bestemmingsveld elkaars debounce-timer niet kunnen verstoren.
    async function fetchAddressSuggestionsNow(query) {
      try {
        const response = await fetch(`${apiBase}/api/places-autocomplete?input=${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data.suggestions || [];
      } catch (err) {
        // Adressuggesties zijn een verrijking, geen harde vereiste — bij
        // een storing valt de widget terug op vrije tekst (zie
        // isFieldConfirmed) in plaats van de klant vast te zetten.
        state.placesUnavailable = true;
        return [];
      }
    }

    // Haalt, voor een BEVESTIGD adres dat niet via een eigen POI-snelkeuze
    // gekozen is, de door Google herkende zone op en controleert of dit
    // adres in de praktijk hetzelfde is als een bekende POI (zie
    // src/maps/resolveAddress.js in de backend, 3 oktober 2026 — vervangt
    // de komma-gok en bouwt de startdocument-bevestigingsvraag "Bedoelt u
    // Eindhoven Airport?"). Roept zelf render() aan zodra het antwoord
    // binnen is (dit gebeurt na een netwerk-rondje, dus nooit synchroon
    // binnen de aanroepende render-cyclus).
    async function resolveAddressZoneAndPoiMatch(field) {
      if (field.poiId) return; // kent al zijn eigen, beheerde zone.
      const address = field.text.trim();
      if (!address) return;
      try {
        const response = await fetch(`${apiBase}/api/resolve-address?address=${encodeURIComponent(address)}`);
        if (!response.ok) return;
        const data = await response.json();
        // De klant kan intussen zijn doorgetypt (een nieuwere aanroep is
        // dan al onderweg of al afgehandeld) — een verlaat antwoord dat
        // niet meer bij de huidige tekst van dit veld past, negeren we,
        // anders zou een oudere zone/bevestigingsvraag over nieuwere tekst
        // heen kunnen vallen.
        if (field.text.trim() !== address) return;
        field.zone = data.zone || null;
        field.poiConfirmPending = data.poiMatch || null;
      } catch (err) {
        // Verrijking, geen harde vereiste (zelfde aanpak als
        // fetchAddressSuggestionsNow hierboven) — bij een storing blijft de
        // widget gewoon werken met de oude komma-gok en zonder
        // bevestigingsvraag.
      }
      render();
    }

    // De backend verwacht `passengerCount` als TOTAAL aantal inzittenden
    // (volwassenen + kinderen samen, zie checkVehicleFit in de backend) --
    // `childCount` komt er apart bovenop voor de volwassene/kinderen-
    // uitsplitsing bij de achterbank-plat-uitzondering. state.passengerCount
    // zelf is puur de teller van het "Aantal volwassenen"-veld; hier wordt
    // het kindertal erbij opgeteld vlak vóór het versturen (Hans, 20
    // augustus 2026: "je kunt nu dus met 4 volwassenen en 1 of meerdere
    // kinderen reizen in een auto geschikt voor 4 passagiers" -- de
    // capaciteitscheck kreeg zonder deze optelling nooit de kinderen te
    // zien).
    function totalPassengerCount() {
      return state.passengerCount + state.childCount;
    }

    // 30 september 2026 (Hans): de taal bij een boeking kwam bij taxiID
    // altijd als "en" binnen, ook op de Nederlandstalige pagina. Oorzaak:
    // deze widget stuurde helemaal geen taal mee, waardoor de backend zijn
    // vaste standaardwaarde gebruikte -- en die stond op "nl-NL", een vorm
    // die taxiID kennelijk niet herkent (hun documentatie-voorbeeld
    // gebruikt een korte code als "EN") en zelf liet terugvallen op "en".
    // document.documentElement.lang volgt de daadwerkelijk getoonde
    // paginataal (WordPress/Weglot zet dit attribuut correct) -- dus een
    // Nederlandstalige bezoeker geeft "NL", een bezoeker op de Engelse
    // (Weglot-)versie geeft "EN".
    function detectPageLanguageCode() {
      const htmlLang = (document.documentElement && document.documentElement.lang) || "";
      const match = /^[a-zA-Z]{2}/.exec(htmlLang.trim());
      return match ? match[0].toUpperCase() : "NL";
    }

    function determineRideMeta() {
      // Richting volgt uit welk veld een herkende POI bevat — geen aparte
      // vraag (zie startdocument, "Gekozen ontwerp: POI-herkenning...").
      if (state.destination.poiId) {
        const poi = findPoiById(state.destination.poiId);
        return {
          direction: "heen",
          poiId: state.destination.poiId,
          // resolveZone (in plaats van rechtstreeks guessZoneFromAddress,
          // 3 oktober 2026): gebruikt de via Google herkende zone van het
          // ophaaladres zodra die bekend is, met de oude gok als vangnet.
          fixedRouteZone: resolveZone(state.origin),
          poi,
        };
      }
      if (state.origin.poiId) {
        const poi = findPoiById(state.origin.poiId);
        return {
          direction: "terug",
          poiId: state.origin.poiId,
          fixedRouteZone: resolveZone(state.destination),
          poi,
        };
      }
      return { direction: "heen", poiId: undefined, fixedRouteZone: undefined, poi: null };
    }

    // Hans, 19 augustus 2026, na zijn eigen tweede test: de "bagage van de
    // band ophalen"-vraag gaat over de wachttijd ná landing, en is dus
    // alleen relevant als de OPHAALLOCATIE een luchthaven is (een
    // aankomende passagier die wordt opgehaald) -- niet bij een rit NAAR de
    // luchthaven (een vertrekkende passagier, waar deze vraag geen betekenis
    // heeft). Vervangt de eerdere, bredere isAirportRide() die beide
    // richtingen liet gelden.
    function isAirportPickup() {
      if (!state.origin.poiId) return false;
      const poi = findPoiById(state.origin.poiId);
      return !!(poi && poi.category === "Vliegveld");
    }

    // --- Vluchtopzoeking (5 oktober 2026, Hans) ------------------------
    // Na het invullen van het vluchtnummer zoeken we via de backend
    // (GET /api/flight-lookup, AeroDataBox) herkomst en geplande aankomst
    // op en tonen die onder het veld: de klant ziet een typefout meteen,
    // en we waarschuwen als de vlucht pas NA het gekozen ophaaltijdstip
    // landt. Puur informatief: een mislukte of lege opzoeking blokkeert
    // nooit en het ingevulde vluchtnummer blijft gewoon staan.
    const FLIGHT_NUMBER_PATTERN = /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/;

    function normalizeFlightNumberInput(raw) {
      const cleaned = String(raw || "").toUpperCase().replace(/[\s-]+/g, "");
      return FLIGHT_NUMBER_PATTERN.test(cleaned) ? cleaned : null;
    }

    function localDateString(date) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    // Vluchtgegevens per rit (13 oktober 2026): de heenrit (ophaalrit vanaf een
    // luchthaven) en de terugrit van een retourboeking (terugrit vanaf de
    // luchthaven waar de heenrit naartoe gaat) gebruiken dezelfde opzoeking,
    // landingscontrole en knoppen. `kind` is "outbound" (standaard) of "return".
    function legFlight(kind) {
      if (kind === "return") {
        return {
          get number() { return state.returnFlightNumber; },
          get info() { return state.returnFlightInfo; },
          set info(v) { state.returnFlightInfo = v; },
          get manualLanding() { return state.returnFlightManualLanding; },
          set manualLanding(v) { state.returnFlightManualLanding = v; },
          get manualOpen() { return state.returnFlightManualOpen; },
          set manualOpen(v) { state.returnFlightManualOpen = v; },
          pickup: () => state.returnDateTime,
          airportPoiId: () => state.destination.poiId,
          active: () => isReturnAirportPickup(),
          adopt: (date) => adoptReturnPickupTime(date, "flight"),
        };
      }
      return {
        get number() { return state.flightNumber; },
        get info() { return state.flightInfo; },
        set info(v) { state.flightInfo = v; },
        get manualLanding() { return state.flightManualLanding; },
        set manualLanding(v) { state.flightManualLanding = v; },
        get manualOpen() { return state.flightManualOpen; },
        set manualOpen(v) { state.flightManualOpen = v; },
        pickup: () => getEffectiveDateTime(),
        airportPoiId: () => state.origin.poiId,
        active: () => isAirportPickup(),
        adopt: (date) => adoptPickupTime(date, "flight"),
      };
    }

    function flightLookupKey(kind) {
      const f = legFlight(kind);
      const flight = normalizeFlightNumberInput(f.number);
      const pickup = f.pickup();
      if (!flight || !pickup) return null;
      return `${flight}|${localDateString(pickup)}`;
    }

    async function lookupFlightInfo(kind) {
      const f = legFlight(kind);
      if (!f.active()) return;
      const key = flightLookupKey(kind);
      if (!key) {
        f.info = null;
        render();
        return;
      }
      if (f.info && f.info.key === key) return;
      f.info = { key, status: "pending", flights: [] };
      render();
      const [flight, date] = key.split("|");
      let result = { key, status: "unavailable", flights: [] };
      try {
        const response = await fetch(
          `${apiBase}/api/flight-lookup?flight=${encodeURIComponent(flight)}&date=${encodeURIComponent(date)}`
        );
        const data = await response.json();
        result = { key, status: data.status || "unavailable", flights: data.flights || [] };
      } catch (err) {
        // Stil negeren: de opzoeking is een extraatje, geen vereiste.
      }
      // Is de klant inmiddels iets anders gaan invullen, dan negeren we dit
      // verouderde antwoord.
      if (!f.info || f.info.key !== key) return;
      f.info = result;
      render();
    }

    // Opzoeken/hertekenen een fractie later dan het 'change'-event: dat event
    // komt van het veld dat de focus verliest, en gebeurt vaak precies terwijl
    // de klant op een knop drukt. Zouden we dan meteen opnieuw tekenen, dan
    // verdwijnt de knop onder de vinger en gaat de eerste klik verloren.
    let flightRefreshTimer = null;
    function scheduleFlightRefresh(fn) {
      if (flightRefreshTimer) clearTimeout(flightRefreshTimer);
      flightRefreshTimer = setTimeout(() => {
        flightRefreshTimer = null;
        fn();
      }, 350);
    }

    // Bij een vlucht met meerdere etappes: kies de etappe die op de gekozen
    // luchthaven aankomt (op naam/plaats), anders de eerste.
    function pickFlightLeg(flights, kind) {
      const poi = findPoiById(legFlight(kind).airportPoiId());
      const poiName = poi ? String(poi.name).toLowerCase() : "";
      const ignore = ["airport", "international", "intl", "airfield"];
      const words = (text) =>
        String(text || "")
          .toLowerCase()
          .split(/[^a-z\u00e0-\u00ff]+/)
          .filter((w) => w.length >= 4 && ignore.indexOf(w) === -1);
      const match = flights.find((f) =>
        words(`${f.destination && f.destination.name} ${f.destination && f.destination.city}`).some((w) => poiName.indexOf(w) !== -1)
      );
      return match || flights[0];
    }

    function formatClock(iso, timeZone) {
      return new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: timeZone || "Europe/Amsterdam" }).format(new Date(iso));
    }

    function formatDayAndClock(iso, timeZone) {
      return new Intl.DateTimeFormat("nl-NL", {
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timeZone || "Europe/Amsterdam",
      }).format(new Date(iso));
    }

    // Neemt een nieuw ophaalmoment over via een knop en legt dat vast.
    function adoptPickupTime(newDate, reason) {
      const from = getEffectiveDateTime();
      state.timeSteps.push({ reason, from: from.toISOString(), to: newDate.toISOString() });
      state.dateTime = newDate;
      state.dateTimeTouched = true;
    }

    // ---- Retourrit (12 oktober 2026) ----

    // De terugrit begint op de bestemming van de heenrit: is dat een luchthaven,
    // dan is het vluchtnummer van de terugvlucht verplicht (zelfde regel als
    // bij een luchthaven-ophaalrit, zie isAirportPickup).
    function isReturnAirportPickup() {
      if (!state.roundTrip || !state.destination.poiId) return false;
      const poi = findPoiById(state.destination.poiId);
      return !!(poi && poi.category === "Vliegveld");
    }

    function adoptReturnPickupTime(newDate, reason) {
      const from = state.returnDateTime;
      state.returnTimeSteps.push({ reason: reason || "capacity", from: from ? from.toISOString() : newDate.toISOString(), to: newDate.toISOString() });
      state.returnDateTime = newDate;
    }

    function currentReturnTimeAdjustments() {
      const steps = state.returnTimeSteps || [];
      if (!steps.length || !state.returnDateTime) return undefined;
      const last = steps[steps.length - 1];
      if (new Date(last.to).getTime() !== state.returnDateTime.getTime()) return undefined;
      return steps.map((step) => ({ reason: step.reason, requestedDateTime: step.from, newDateTime: step.to }));
    }

    // Het deel van de aanvraag voor de terugrit, of undefined zonder retourrit.
    function returnTripBody(withDetails) {
      if (!state.roundTrip || !state.returnDateTime) return undefined;
      const body = { dateTime: state.returnDateTime.toISOString() };
      if (withDetails) {
        const flight = isReturnAirportPickup() ? normalizeFlightNumberInput(state.returnFlightNumber) || state.returnFlightNumber.trim() : "";
        if (flight) body.flightNumber = flight;
        const adjustments = currentReturnTimeAdjustments();
        if (adjustments) body.timeAdjustments = adjustments;
        // Notitie voor de chauffeur bij een terugrit vanaf een luchthaven
        // (zelfde zinnen als bij de heenrit).
        if (isReturnAirportPickup()) {
          const parts = [];
          if (hasBaggageToCollect()) parts.push("Passagier moet bagage van de bagageband ophalen (langere wachttijd na landing).");
          else if (state.hasBaggage === false) parts.push("Passagier heeft alleen handbagage bij zich.");
          const manualLanding = manualLandingDate("return");
          if (manualLanding) parts.push(`Geplande landingstijd (door passagier opgegeven): ${formatClock(manualLanding.toISOString())}.`);
          if (parts.length) body.note = parts.join(" ");
        }
      }
      return body;
    }

    // Knop "Ophaaltijd aanpassen aan de landing": alleen als de gekozen
    // ophaaltijd vóór de landing ligt (Hans, 6 oktober 2026: niet bij een
    // latere tijd). De ophaaltijd wordt precies de landingstijd.
    function renderAdjustToLandingButton(landingDate, kind) {
      const f = legFlight(kind);
      const pickup = f.pickup();
      if (!pickup || !(pickup.getTime() < landingDate.getTime())) return null;
      return el("button", {
        type: "button",
        class: "wnt-button wnt-button-danger wnt-button-small",
        text: `Ophaaltijd aanpassen aan de landing (${formatClock(landingDate.toISOString())})`,
        onclick: () => {
          f.adopt(landingDate);
          render();
          // De opzoeking geldt per ophaaldatum; die kan hiermee zijn verschoven.
          if (f.active() && f.number.trim()) lookupFlightInfo(kind);
        },
      });
    }

    // Landingstijd uit de opzoeking (ISO) of null.
    function lookedUpLandingIso(kind) {
      const info = legFlight(kind).info;
      if (!info || info.status !== "found" || !info.flights || !info.flights.length) return null;
      const leg = pickFlightLeg(info.flights, kind);
      return leg.estimatedArrivalUtc || leg.scheduledArrivalUtc || null;
    }

    // Bekende landing (opzoeking of door de passagier ingevuld) die NA de
    // gekozen ophaaltijd ligt, anders null. Hans, 6 oktober 2026: de klant
    // mag pas naar de bagage-stap als dit is opgelost -- door de rode knop
    // te gebruiken of zelf een ophaaltijd vanaf de landing te kiezen.
    function landingAfterPickup(kind) {
      const f = legFlight(kind);
      const pickup = f.pickup();
      if (!f.active() || !f.number.trim() || !pickup) return null;
      const iso = lookedUpLandingIso(kind);
      const landing = iso ? new Date(iso) : manualLandingDate(kind);
      if (!landing || isNaN(landing.getTime())) return null;
      return pickup.getTime() < landing.getTime() ? landing : null;
    }

    // Door de passagier ingevulde landingstijd als Date, op de ophaaldag.
    // Landt de vlucht 's avonds en is de rit na middernacht (tijd ligt dan
    // meer dan 12 uur NA de ophaaltijd), dan nemen we de dag ervoor.
    function manualLandingDate(kind) {
      const f = legFlight(kind);
      const match = /^(\d{1,2}):(\d{2})$/.exec(f.manualLanding || "");
      const pickup = f.pickup();
      if (!match || !pickup || lookedUpLandingIso(kind)) return null;
      const landing = new Date(pickup);
      landing.setHours(Number(match[1]), Number(match[2]), 0, 0);
      if (landing.getTime() - pickup.getTime() > 12 * 3600 * 1000) landing.setDate(landing.getDate() - 1);
      return landing;
    }

    // Knop/veld om de geplande landingstijd zelf in te vullen, getoond zodra
    // er een vluchtnummer staat en de opzoeking geen landingstijd gaf.
    function renderManualLanding(kind) {
      const f = legFlight(kind);
      if (!f.number.trim() || lookedUpLandingIso(kind)) return null;
      if (f.info && f.info.status === "pending") return null;
      const pickup = f.pickup();
      const wrapper = el("div", { class: "wnt-flight-manual" });
      if (!f.manualOpen && !f.manualLanding) {
        wrapper.appendChild(
          el("button", {
            type: "button",
            class: "wnt-button wnt-button-secondary wnt-button-small",
            text: "Geplande landingstijd zelf invullen",
            onclick: () => {
              f.manualOpen = true;
              render();
            },
          })
        );
        return wrapper;
      }
      wrapper.appendChild(el("label", { text: "Geplande landingstijd (volgens uw ticket)" }));
      wrapper.appendChild(
        el("input", {
          type: "time",
          value: f.manualLanding,
          onchange: (e) => {
            f.manualLanding = e.target.value || "";
            render();
          },
        })
      );
      wrapper.appendChild(
        el("button", {
          type: "button",
          class: "wnt-button wnt-button-secondary wnt-button-small",
          text: "Wissen",
          onclick: () => {
            f.manualLanding = "";
            f.manualOpen = false;
            render();
          },
        })
      );
      const landing = manualLandingDate(kind);
      if (landing && pickup && pickup.getTime() < landing.getTime()) {
        wrapper.appendChild(
          el("p", { class: "wnt-warning" }, [
            `Let op: uw vlucht landt om ${formatClock(landing.toISOString())}, na uw gekozen ophaaltijd (${formatClock(pickup.toISOString())}). U kunt pas verder nadat u de ophaaltijd hebt aangepast.`,
          ])
        );
        const adjustButton = renderAdjustToLandingButton(landing, kind);
        if (adjustButton) wrapper.appendChild(adjustButton);
      }
      return wrapper;
    }

    function renderFlightInfo(kind) {
      const f = legFlight(kind);
      const info = f.info;
      if (!info) {
        if (f.number.trim() && !normalizeFlightNumberInput(f.number)) {
          return el("p", { class: "wnt-hint wnt-flight-info" }, [
            "Dit lijkt geen vluchtnummer. Een vluchtnummer bestaat uit twee letters/cijfers en een nummer, bijvoorbeeld KL1234 of KL 1234.",
          ]);
        }
        return null;
      }
      if (info.status === "pending") {
        return el("p", { class: "wnt-hint wnt-flight-info", text: "Vlucht opzoeken…" });
      }
      if (info.status === "not_found") {
        return el("p", { class: "wnt-hint wnt-flight-info" }, [
          "We konden dit vluchtnummer niet vinden voor deze datum. Controleer het nummer en de ophaaldatum. U kunt ook gewoon doorgaan.",
        ]);
      }
      if (info.status !== "found" || !info.flights || !info.flights.length) return null;

      const leg = pickFlightLeg(info.flights, kind);
      const pickup = f.pickup();
      const tz = leg.arrivalTimeZone || "Europe/Amsterdam";
      const where = [leg.origin.city || leg.origin.name, leg.origin.iata ? `(${leg.origin.iata})` : ""].filter(Boolean).join(" ");
      const wrapper = el("div", { class: "wnt-flight-info" });
      const landing = leg.estimatedArrivalUtc || leg.scheduledArrivalUtc;
      const parts = [el("strong", { text: leg.number || normalizeFlightNumberInput(f.number) }), ` komt uit ${where}`];
      if (leg.scheduledArrivalUtc) {
        parts.push(`, geplande aankomst ${formatDayAndClock(leg.scheduledArrivalUtc, tz)}`);
        if (leg.estimatedArrivalUtc && leg.estimatedArrivalUtc !== leg.scheduledArrivalUtc) {
          parts.push(` (verwacht ${formatClock(leg.estimatedArrivalUtc, tz)})`);
        }
      }
      parts.push(". Klopt dit? Zo niet, controleer dan het vluchtnummer.");
      wrapper.appendChild(el("p", { class: "wnt-hint" }, parts));

      if (landing && pickup && pickup.getTime() < new Date(landing).getTime()) {
        wrapper.appendChild(
          el("p", { class: "wnt-warning" }, [
            `Let op: deze vlucht landt om ${formatClock(landing, tz)}, na uw gekozen ophaaltijd (${formatClock(pickup.toISOString(), tz)}). U kunt pas verder nadat u de ophaaltijd hebt aangepast.`,
          ])
        );
        const adjustButton = renderAdjustToLandingButton(new Date(landing), kind);
        if (adjustButton) wrapper.appendChild(adjustButton);
      }
      return wrapper;
    }

    // Heeft de klant al "Grote ruimbagage" opgegeven, dan weten we al dat er
    // bagage van de band gehaald moet worden -- de losse vraag hieronder is
    // dan overbodig (Hans, 19 augustus 2026). "grote_ruimbagage" is het id
    // uit de meegeleverde configuratie (zie pricingConfig.json/`/admin`);
    // mocht dat id ooit wijzigen, dan valt deze check simpelweg terug op
    // "geen grote ruimbagage bekend" en wordt de vraag weer gewoon gesteld.
    function hasLargeCheckedBaggage() {
      return (state.baggageCounts.grote_ruimbagage || 0) > 0;
    }

    // Hans, 5 oktober 2026: "Als er afwijkende bagage wordt gekozen en de
    // klant heeft geen grote koffer bij, dan komt toch de vraag over bagage
    // van de band -- dat lijkt me overbodig." Klopt: een skiset, rollator,
    // rolstoel, scootmobiel, kinderwagen of golfset reist als ruimbagage (of
    // via de balie voor bijzondere bagage) en moet na de landing opgehaald
    // worden, net als een grote koffer. Het antwoord staat dus al vast en de
    // losse vraag wordt niet meer gesteld.
    function hasSpecialBaggage() {
      return !!state.specialBaggageId && state.specialBaggageId !== "geen";
    }

    function hasBaggageToCollect() {
      return hasLargeCheckedBaggage() || hasSpecialBaggage();
    }

    function shouldAskAirportBaggageQuestion() {
      return isAirportPickup() && !hasBaggageToCollect();
    }

    // Vroege, informatieve werkgebied-check (Hans, 19 augustus 2026, na zijn
    // eigen eerste test met de widget: "ik denk dat we mensen meteen moeten
    // informeren in het eerste scherm"). Zelfde regel als de server
    // (isRideWithinServiceArea in pricingEngine.js): toegestaan zodra het
    // ophaal- ÓF het bestemmingsadres in het werkgebied ligt, gematcht via
    // dezelfde zone-gok (guessZoneFromAddress) als elders in deze widget.
    //
    // Bewust WAARSCHUWEND, niet blokkerend: de zone-gok is een gok (zie
    // guessZoneFromAddress hierboven) en kan dus fout zitten. De server
    // blijft de uiteindelijke, harde beslissing nemen bij het opvragen van
    // de prijs/boeking (zie priceRoute.js/bookRoute.js) — die weigert een
    // rit pas écht. Hier gaat het er alleen om de klant niet onnodig het
    // hele formulier te laten doorlopen voordat hij dat te horen krijgt.
    function isRideWithinServiceArea() {
      const zones = state.config.serviceAreaZones;
      if (!Array.isArray(zones) || zones.length === 0) return true; // nog niet geconfigureerd -> geen beperking

      const allowed = zones.map((z) => z.trim().toLowerCase());
      const matches = (zone) => !!zone && allowed.includes(zone.trim().toLowerCase());

      const originZone = resolveZone(state.origin);
      const destinationZone = resolveZone(state.destination);
      return matches(originZone) || matches(destinationZone);
    }

    async function fetchConfig() {
      try {
        const response = await fetch(`${apiBase}/api/config`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.config = await response.json();
        state.step = "ride";
      } catch (err) {
        state.loadError =
          "Kan de configuratie niet laden. Probeer de pagina te verversen, of neem contact op als dit blijft gebeuren.";
      }
      render();
    }

    async function fetchPrice() {
      const sentDiscountCode = state.discountCode;
      state.submitting = true;
      state.priceError = null;
      render();

      const meta = determineRideMeta();
      const body = {
        passengerCount: totalPassengerCount(),
        childCount: state.childCount,
        baggageCounts: state.baggageCounts,
        specialBaggageId: state.specialBaggageId,
        direction: meta.direction,
        dateTime: getEffectiveDateTime().toISOString(),
        poiId: meta.poiId,
        fixedRouteZone: meta.fixedRouteZone || undefined,
        // Zone van elk adres afzonderlijk (zelfde gok als fixedRouteZone,
        // zie guessZoneFromAddress), nodig voor het per-plaats
        // minimumtarief -- dit geldt voor élke rit, niet alleen POI-ritten
        // (bijvoorbeeld een kort ritje binnen Waalre, zonder POI).
        originZone: resolveZone(state.origin) || undefined,
        destinationZone: resolveZone(state.destination) || undefined,
        originAddress: state.origin.text,
        destinationAddress: state.destination.text,
        discountCode: sentDiscountCode || undefined,
        returnTrip: returnTripBody(false),
      };

      try {
        const response = await fetch(`${apiBase}/api/price`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok) {
          state.priceError = data.details
            ? `${data.error}: ${JSON.stringify(data.details)}`
            : data.error || `HTTP ${response.status}`;
        } else {
          state.priceResult = data;
          state.step = "vehicles";
          if (sentDiscountCode) {
            if (data.discount) {
              state.discountApplied = data.discount;
              state.discountError = null;
            } else {
              // Niet (meer) bruikbaar: geen code meer meesturen (anders blijft
              // elke prijsaanvraag een foute poging) en de reden tonen.
              state.discountApplied = null;
              state.discountCode = "";
              state.discountError = (data.discountError && data.discountError.message) || "Deze kortingscode kon niet worden gebruikt.";
            }
          }
        }
      } catch (err) {
        state.priceError = "Kon geen verbinding maken met de prijsberekening. Probeer het opnieuw.";
      }

      state.submitting = false;
      render();
    }

    function currentTimeAdjustments() {
      const steps = state.timeSteps || [];
      if (!steps.length) return undefined;
      const last = steps[steps.length - 1];
      if (new Date(last.to).getTime() !== getEffectiveDateTime().getTime()) return undefined;
      return steps.map((step) => ({ reason: step.reason, requestedDateTime: step.from, newDateTime: step.to }));
    }

    // ---- Kortingscode (11 oktober 2026) ----

    function applyDiscountInput() {
      const code = state.discountInput.trim();
      if (!code) {
        state.discountError = "Vul een kortingscode in.";
        render();
        return;
      }
      state.discountCode = code;
      state.discountError = null;
      fetchPrice();
    }

    function removeDiscount() {
      state.discountCode = "";
      state.discountApplied = null;
      state.discountError = null;
      state.discountInput = "";
      state.discountOpen = false;
      fetchPrice();
    }

    // ---- Online betalen: terugkeer van de betaalpagina (8 oktober 2026) ----

    // Het adres van deze pagina zonder onze eigen terugkeer-parameters; hier
    // stuurt MultiSafepay de klant na het betalen naartoe.
    function currentReturnUrl() {
      const url = new URL(window.location.href);
      url.hash = "";
      url.searchParams.delete("wnt_order");
      url.searchParams.delete("wnt_cancelled");
      return url.toString();
    }

    function getReturnOrderId() {
      try {
        const id = new URLSearchParams(window.location.search).get("wnt_order");
        return /^WNT[0-9a-f]{32}$/.test(id || "") ? id : null;
      } catch (err) {
        return null;
      }
    }

    function startPaymentReturn(orderId) {
      let cancelled = false;
      try {
        cancelled = new URLSearchParams(window.location.search).get("wnt_cancelled") === "1";
      } catch (err) {
        /* negeren */
      }
      state.step = "payment";
      state.payment = { orderId, view: null, error: null, cancelled, gaveUp: false, startedAt: Date.now() };
      render();
      pollPaymentStatus();
    }

    async function pollPaymentStatus() {
      const p = state.payment;
      try {
        const response = await fetch(`${apiBase}/api/booking-status?order=${encodeURIComponent(p.orderId)}`, { cache: "no-store" });
        if (response.status === 404) {
          p.view = { status: "unknown" };
          p.error = null;
          render();
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        p.view = await response.json();
        p.error = null;
      } catch (err) {
        p.error = "Kon de status van uw betaling niet ophalen. We proberen het opnieuw…";
      }
      const status = p.view && p.view.status;
      const keepPolling = !p.view || status === "awaiting_payment" || status === "processing";
      if (keepPolling && Date.now() - p.startedAt >= 15 * 60 * 1000) p.gaveUp = true;
      render();
      if (keepPolling && !p.gaveUp) setTimeout(pollPaymentStatus, 2500);
    }

    async function submitBooking() {
      state.submitting = true;
      state.bookError = null;
      render();

      const meta = determineRideMeta();
      const noteParts = [];
      if (isAirportPickup()) {
        // Grote ruimbagage of bijzondere bagage opgegeven? Dan staat het
        // antwoord feitelijk al vast, ook als de vraag zelf (bewust) niet
        // gesteld is -- zie
        // shouldAskAirportBaggageQuestion hierboven.
        const effectiveAnswer = hasBaggageToCollect() ? "ruimbagage" : state.airportBaggageAnswer;
        if (effectiveAnswer) {
          noteParts.push(
            effectiveAnswer === "ruimbagage"
              ? "Passagier moet bagage van de bagageband ophalen (langere wachttijd na landing)."
              : "Passagier heeft alleen handbagage bij zich."
          );
        }
      }
      if (isAirportPickup()) {
        const manualLanding = manualLandingDate();
        if (manualLanding) {
          noteParts.push(`Geplande landingstijd (door passagier opgegeven): ${formatClock(manualLanding.toISOString())}.`);
        }
      }
      if (state.note) noteParts.push(state.note);

      const body = {
        vehicleId: state.selectedVehicleId,
        passengerCount: totalPassengerCount(),
        childCount: state.childCount,
        baggageCounts: state.baggageCounts,
        specialBaggageId: state.specialBaggageId,
        direction: meta.direction,
        dateTime: getEffectiveDateTime().toISOString(),
        poiId: meta.poiId,
        fixedRouteZone: meta.fixedRouteZone || undefined,
        originZone: resolveZone(state.origin) || undefined,
        destinationZone: resolveZone(state.destination) || undefined,
        originAddress: state.origin.text,
        destinationAddress: state.destination.text,
        passenger: { ...state.passenger, language: detectPageLanguageCode() },
        note: noteParts.join(" ") || undefined,
        // Het vinkje bij "Gegevens"; de server eist dit en legt het tijdstip vast.
        termsAccepted: state.termsAccepted === true,
        // Los van `note`: taxiID's Ride-schema heeft hier een eigen
        // `flightNumber`-veld voor (zie backend/taxiidClient.js). Alleen
        // relevant/ingevuld bij isAirportPickup() -- in alle andere
        // gevallen blijft state.flightNumber op zijn standaard lege
        // waarde staan.
        flightNumber: normalizeFlightNumberInput(state.flightNumber) || state.flightNumber.trim() || undefined,
        // 6 oktober 2026: elke via een knop overgenomen tijdwijziging
        // (capaciteit/landing), zodat de rit bij taxiID een duidelijke
        // melding krijgt. Alleen als de laatste stap nog de gekozen tijd is.
        timeAdjustments: currentTimeAdjustments(),
        // 8 oktober 2026 (online betalen): alleen wat de klant zelf als
        // opmerking typte, voor het bevestigingsscherm; en de pagina waar
        // de klant na het betalen naartoe teruggestuurd wordt.
        customerNote: state.note || undefined,
        returnUrl: currentReturnUrl(),
        // Kortingscode (11 oktober 2026): alleen als de server hem bij het
        // tonen van de prijzen heeft bevestigd; de server controleert hem
        // bij het boeken opnieuw en rekent de korting zelf uit.
        discountCode: state.discountApplied ? state.discountApplied.code : undefined,
        returnTrip: returnTripBody(true),
      };

      try {
        const response = await fetch(`${apiBase}/api/book`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok && data.discountError) {
          // De code geldt niet meer (bv. net door iemand anders gebruikt):
          // terug naar de voertuigkeuze met de normale prijzen en de reden.
          state.discountApplied = null;
          state.discountCode = "";
          state.bookError = null;
          state.submitting = false;
          await fetchPrice();
          state.discountError = `${data.error} De prijzen zijn opnieuw berekend zonder korting.`;
          render();
          return;
        } else if (!response.ok) {
          state.bookError = data.details ? `${data.error}: ${JSON.stringify(data.details)}` : data.error || `HTTP ${response.status}`;
        } else if (data.requiresPayment && data.paymentUrl) {
          // Online betalen: de rit wordt pas aangemaakt nadat de betaling
          // bevestigd is. De klant gaat naar de betaalpagina van
          // MultiSafepay en komt daarna terug op deze pagina (?wnt_order=...).
          state.step = "redirecting";
          render();
          window.location.href = data.paymentUrl;
          return;
        } else {
          state.bookResult = data;
          state.step = "success";
        }
      } catch (err) {
        state.bookError = "Kon geen verbinding maken om te boeken. Probeer het opnieuw.";
      }

      state.submitting = false;
      render();
    }

    // ---- Rendering ----

    // ---- Meldingen bij het veld (14 oktober 2026) ----
    // In plaats van een browser-pop-up (alert) komt de melding direct onder het
    // betreffende veld, met een rode rand; de pagina scrolt naar de eerste.
    // Een melding verdwijnt zodra de klant het veld aanpast; bij meldingen die
    // van de situatie afhangen (landing na ophaaltijd) controleert `check` of
    // het probleem er nog is.
    function fieldErrorMessage(key) {
      const entry = state.fieldErrors[key];
      if (!entry) return null;
      if (entry.check && !entry.check()) return null;
      return entry.message;
    }

    function fieldErrorNode(key) {
      const message = fieldErrorMessage(key);
      if (!message) return null;
      return el("p", { class: "wnt-field-error", role: "alert", "data-wnt-error": key, text: message });
    }

    function invalidAttrs(key) {
      return fieldErrorMessage(key) ? { class: "wnt-invalid", "aria-invalid": "true" } : {};
    }

    function clearFieldError(key, inputNode) {
      if (!state.fieldErrors[key]) return;
      delete state.fieldErrors[key];
      const errorNode = document.querySelector(`[data-wnt-error="${key}"]`);
      if (errorNode) errorNode.remove();
      if (inputNode) {
        inputNode.classList.remove("wnt-invalid");
        inputNode.removeAttribute("aria-invalid");
      }
    }

    // errors: lijst van [sleutel, bericht, check?]. Tekent opnieuw en gaat naar
    // het eerste veld met een melding. Geen meldingen -> niets doen, true.
    function showFieldErrors(errors) {
      state.fieldErrors = {};
      errors.forEach(([key, message, check]) => {
        if (!state.fieldErrors[key]) state.fieldErrors[key] = { message, check };
      });
      if (!errors.length) return true;
      render();
      const target = document.querySelector("[data-wnt-error]");
      if (target) {
        const field = target.closest(".wnt-field") || target;
        field.scrollIntoView({ block: "center", behavior: "smooth" });
        // Niet de adresvelden focussen: dat opent meteen de suggestielijst
        // over de melding heen.
        const input = field.classList.contains("wnt-address-field") ? null : field.querySelector(".wnt-invalid");
        if (input && typeof input.focus === "function") input.focus({ preventScroll: true });
      }
      return false;
    }

    function renderAddressField(labelText, fieldKey, onFieldChange) {
      const field = state[fieldKey];
      const wrapper = el("div", { class: "wnt-field wnt-address-field" });
      wrapper.appendChild(el("label", { text: labelText }));

      const suggestions = el("div", { class: "wnt-suggestions", hidden: true });
      // Debounce-timer en laatst opgehaalde Google-suggesties, apart per
      // veld (deze closure bestaat per renderAddressField-aanroep) — zodat
      // het ophaaladres- en bestemmingsveld elkaars timer niet verstoren.
      let debounceTimer = null;
      let lastPlaceSuggestions = [];

      function selectSuggestion(text, poiId) {
        clearFieldError(fieldKey, input);
        field.text = text;
        field.poiId = poiId || null;
        field.confirmed = true;
        // Nieuwe tekst -> een eventuele oudere zone/bevestigingsvraag is
        // niet meer geldig (zie resolveAddressZoneAndPoiMatch).
        field.zone = null;
        field.poiConfirmPending = null;
        suggestions.hidden = true;
        if (onFieldChange) onFieldChange();
        render();
        // Alleen de moeite waard voor een gewoon (niet via POI-snelkeuze
        // gekozen) adres -- resolveAddressZoneAndPoiMatch slaat zelf over
        // als field.poiId al gezet is.
        resolveAddressZoneAndPoiMatch(field);
      }

      function renderSuggestionList(query) {
        const pois = state.config.pois || [];
        // Zoeken op naam, categorie en gelijkwaardige woorden (14 oktober 2026,
        // Hans): "ziekenhuis" toont alle locaties met die categorie, en
        // "vliegveld", "luchthaven" en "airport" worden als hetzelfde gezien.
        const poiMatches = query ? pois.filter((p) => poiMatchesQuery(p, query)) : pois;

        suggestions.innerHTML = "";
        let hasContent = false;

        poiMatches.forEach((poi) => {
          hasContent = true;
          suggestions.appendChild(
            el(
              "button",
              { type: "button", class: "wnt-suggestion", onclick: () => selectSuggestion(poi.name, poi.id) },
              [el("span", { class: "wnt-suggestion-badge", text: poi.category }), " " + poi.name]
            )
          );
        });

        lastPlaceSuggestions.forEach((place) => {
          hasContent = true;
          suggestions.appendChild(
            el(
              "button",
              { type: "button", class: "wnt-suggestion", onclick: () => selectSuggestion(place.description, null) },
              [el("span", { class: "wnt-suggestion-badge wnt-suggestion-badge-address", text: "Adres" }), " " + place.description]
            )
          );
        });

        if (state.placesUnavailable && query) {
          hasContent = true;
          suggestions.appendChild(
            el("p", { class: "wnt-hint wnt-suggestions-hint" }, [
              "Live adressuggesties zijn nu niet beschikbaar. U kunt het adres gewoon volledig zelf intypen.",
            ])
          );
        }

        suggestions.hidden = !hasContent;
      }

      function refreshSuggestions(query) {
        // Toon meteen de bekende-POI-matches (die hebben geen netwerk nodig),
        // en ververs de Google-suggesties pas na de debounce.
        renderSuggestionList(query);
        clearTimeout(debounceTimer);
        if (!query || query.trim().length < 3 || state.placesUnavailable) {
          lastPlaceSuggestions = [];
          return;
        }
        debounceTimer = setTimeout(async () => {
          const wasUnavailable = state.placesUnavailable;
          lastPlaceSuggestions = await fetchAddressSuggestionsNow(query);
          renderSuggestionList(query);
          // state.placesUnavailable kan hier pas ná de aanroep echt vastgesteld
          // worden (zie fetchAddressSuggestionsNow) -- ligt dat anders dan
          // vóór deze aanroep, dan is bijvoorbeeld isFieldConfirmed() net
          // veranderd zonder dat er een nieuwe toetsaanslag was. Zonder deze
          // herberekening zou de werkgebied-waarschuwing dan tot de
          // eerstvolgende toetsaanslag verstopt kunnen blijven staan.
          if (state.placesUnavailable !== wasUnavailable && onFieldChange) onFieldChange();
        }, 350);
      }

      const recognized = el("p", { class: "wnt-recognized", hidden: true });

      function updateRecognized() {
        if (field.poiId) {
          const poi = findPoiById(field.poiId);
          recognized.textContent = `✓ Herkend als ${poi.name}. Waar mogelijk rekenen we een vast tarief.`;
          recognized.hidden = false;
        } else if (field.confirmed) {
          recognized.textContent = "✓ Adres bevestigd.";
          recognized.hidden = false;
        } else {
          recognized.hidden = true;
        }
      }
      updateRecognized();

      // De geocoding-bevestigingsvraag uit het startdocument ("Bedoelt u
      // Eindhoven Airport? Dan geldt ons vaste tarief en vragen we straks
      // naar uw vluchtnummer.") — getoond zodra resolveAddressZoneAndPoiMatch
      // hierboven een poiMatch teruggeeft voor een adres dat de klant zelf
      // (niet via de naam/snelkeuze) heeft ingevoerd. "Ja" laat dit veld
      // vanaf dan precies werken als een POI-snelkeuze (vaste prijs,
      // vluchtnummer-vraag bij een luchthaven-ophaalrit, enz.); "Nee" laat
      // het gewoon een los adres blijven (met de inmiddels bekende, echte
      // zone, geen komma-gok meer).
      const poiConfirm = el("div", { class: "wnt-poi-confirm", hidden: true });

      function updatePoiConfirm() {
        const match = field.poiConfirmPending;
        poiConfirm.innerHTML = "";
        if (!match) {
          poiConfirm.hidden = true;
          return;
        }
        const question =
          match.category === "Vliegveld"
            ? `Bedoelt u ${match.name}? Dan geldt ons vaste tarief en vragen we straks naar uw vluchtnummer.`
            : `Bedoelt u ${match.name}? Dan geldt ons vaste tarief.`;
        poiConfirm.appendChild(el("p", { class: "wnt-poi-confirm-question" }, [question]));
        poiConfirm.appendChild(
          el("div", { class: "wnt-poi-confirm-buttons" }, [
            el("button", {
              type: "button",
              class: "wnt-button wnt-button-primary wnt-button-small",
              text: `Ja, dat klopt`,
              onclick: () => {
                field.poiId = match.id;
                field.text = match.name;
                field.zone = null;
                field.poiConfirmPending = null;
                field.confirmed = true;
                if (onFieldChange) onFieldChange();
                render();
              },
            }),
            el("button", {
              type: "button",
              class: "wnt-button wnt-button-secondary wnt-button-small",
              text: "Nee, dit gewone adres",
              onclick: () => {
                field.poiConfirmPending = null;
                if (onFieldChange) onFieldChange();
                render();
              },
            }),
          ])
        );
        poiConfirm.hidden = false;
      }
      updatePoiConfirm();

      const input = el("input", {
        type: "text",
        value: field.text,
        placeholder: "Adres, plaatsnaam of bekende bestemming",
        autocomplete: "off",
        ...(fieldErrorMessage(fieldKey) ? { "aria-invalid": "true" } : {}),
        class: fieldErrorMessage(fieldKey) ? "wnt-invalid" : undefined,
        oninput: (e) => {
          const hadPoiId = !!field.poiId;
          clearFieldError(fieldKey, e.target);
          field.text = e.target.value;
          // Nieuwe tekst -> een eventuele oudere zone/bevestigingsvraag is
          // niet meer geldig (zie resolveAddressZoneAndPoiMatch).
          field.zone = null;
          field.poiConfirmPending = null;
          const poiMatch = matchPoiByText(field.text);
          if (poiMatch) {
            field.poiId = poiMatch.id;
            field.confirmed = true;
          } else {
            field.poiId = null;
            const exactPlaceMatch = lastPlaceSuggestions.find(
              (s) => s.description.trim().toLowerCase() === field.text.trim().toLowerCase()
            );
            field.confirmed = !!exactPlaceMatch;
            if (field.confirmed) resolveAddressZoneAndPoiMatch(field);
          }
          refreshSuggestions(field.text);
          updateRecognized();
          if (onFieldChange) onFieldChange();
          // Hans, 4 oktober 2026: typt een klant het adres van een POI
          // letterlijk exact uit (matchPoiByText hierboven), dan wordt
          // field.poiId meteen gezet -- maar de hierboven gedane updates
          // zijn bewust lokaal (geen volledige render(), om de cursor
          // tijdens gewoon typen niet te laten springen). Daardoor bleef
          // bijvoorbeeld het Vluchtnummer-veld (isAirportPickup(), alleen
          // zichtbaar via een volledige render()) verborgen totdat er
          // toevallig ergens anders iets een render triggerde. Fix:
          // alleen bij een daadwerkelijke overgang (poiId gezet/ontzet),
          // niet bij elke toetsaanslag, alsnog een volledige render().
          if (!!field.poiId !== hadPoiId) {
            render();
          }
        },
        onfocus: () => refreshSuggestions(field.text),
        onblur: () => setTimeout(() => (suggestions.hidden = true), 150),
      });

      wrapper.appendChild(input);
      wrapper.appendChild(suggestions);
      wrapper.appendChild(recognized);
      wrapper.appendChild(poiConfirm);
      const addressErrorNode = fieldErrorNode(fieldKey);
      if (addressErrorNode) wrapper.appendChild(addressErrorNode);

      return wrapper;
    }

    // 9 oktober 2026 (Hans): vluchtnummer, landingstijd en de "bagageband"-
    // keuze horen alleen bij een ophaalrit vanaf een luchthaven. Wijzigt de
    // klant het ophaaladres naar iets anders, dan wissen we ze, zodat ze niet
    // blijven staan en bij een latere luchthaven-keuze ineens ongemerkt weer
    // terugkomen. Wordt aan het begin van elke render() aangeroepen: de
    // overgang luchthaven <-> geen luchthaven triggert altijd een render()
    // (zie renderAddressField), dus dit loopt nooit achter.
    function resetAirportOnlyState() {
      if (isAirportPickup()) return;
      state.flightNumber = "";
      state.flightInfo = null;
      state.flightManualLanding = "";
      state.flightManualOpen = false;
      state.airportBaggageAnswer = null;
    }

    // Zet bagage-gerelateerde state terug naar de neutrale standaardwaarde
    // ("geen bagage") -- gebruikt zodra de klant op stap 1 alsnog "Nee"
    // kiest bij "Heeft u bagage die mee moet?", zodat eerder op stap 2
    // ingevulde aantallen niet blijven meetellen in de prijs-/bagagecheck
    // (zie de toelichting bij de onchange-handler hieronder).
    function resetBaggageSelections() {
      state.baggageCounts = {};
      state.specialBaggageId = "geen";
      state.airportBaggageAnswer = null;
    }

    function renderRideStep() {
      const container = el("div", { class: "wnt-step" });
      container.appendChild(el("h2", { text: "Uw rit" }));

      // Werkgebied-waarschuwing: direct bijgewerkt (geen render()) zodra één
      // van beide adresvelden verandert, zodat typen niet de focus/cursor
      // verliest -- zelfde principe als updateRecognized() hierboven. Ligt
      // onder de adresvelden, dus meteen zichtbaar op dit eerste scherm
      // (Hans, 19 augustus 2026: "ik denk dat we mensen meteen moeten
      // informeren in het eerste scherm").
      const serviceAreaWarning = el("p", { class: "wnt-warning", hidden: true });
      function updateServiceAreaWarning() {
        // Pas tonen zodra BEIDE adressen bevestigd zijn (niet alleen
        // "niet leeg") -- anders verscheen de waarschuwing al na een paar
        // getypte letters van de bestemming, terwijl de ophaallocatie (bv.
        // Eindhoven Airport) prima binnen het werkgebied ligt (Hans, 20
        // augustus 2026: "dat lijkt mij te vroeg en voor onrust zorgen").
        // isFieldConfirmed() is dezelfde toets die ook de "Verder"-knop al
        // gebruikt, dus dit blijft consistent met wanneer een adres als
        // "af" geldt.
        const bothFilled = state.origin.text.trim() && state.destination.text.trim();
        const bothConfirmed = isFieldConfirmed(state.origin) && isFieldConfirmed(state.destination);
        if (bothFilled && bothConfirmed && !isRideWithinServiceArea()) {
          serviceAreaWarning.textContent =
            "Let op: deze rit lijkt buiten ons werkgebied te vallen. Online boeken is dan helaas niet mogelijk — neem telefonisch contact met ons op, dan maken we samen een offerte.";
          serviceAreaWarning.hidden = false;
        } else {
          serviceAreaWarning.hidden = true;
        }
      }
      updateServiceAreaWarning();

      // Retourrit (12 oktober 2026): toont/verbergt het vluchtnummer van de
      // terugvlucht en de tekst "van ... naar ..." zodra een adres verandert,
      // zonder het hele scherm opnieuw te tekenen (zelfde reden als hierboven:
      // typen mag de focus niet verliezen).
      let updateReturnBlock = () => {};
      const onAddressChange = () => {
        updateServiceAreaWarning();
        updateReturnBlock();
      };
      container.appendChild(renderAddressField("Ophaaladres", "origin", onAddressChange));
      container.appendChild(renderAddressField("Bestemming", "destination", onAddressChange));
      container.appendChild(serviceAreaWarning);

      const dateWrapper = el("div", { class: "wnt-field" });
      dateWrapper.appendChild(el("label", { text: "Ophaaldatum en -tijd" }));
      dateWrapper.appendChild(
        el("input", {
          type: "datetime-local",
          value: toDateTimeLocalValue(getEffectiveDateTime()),
          onchange: (e) => {
            if (e.target.value) {
              state.dateTime = localInputValueToDate(e.target.value);
              state.timeSteps = [];
              state.dateTimeTouched = true;
            }
            render();
            // Andere ophaaldag: de vluchtopzoeking geldt per datum.
            if (isAirportPickup() && state.flightNumber.trim()) lookupFlightInfo();
          },
        })
      );
      // 10 oktober 2026 (Hans, om ruimte te besparen): compacte regel met een
      // ⓘ-knop die de uitleg over de 24 uur inline openklapt (geen pop-up:
      // werkt ook in een iframe/mobiel zonder extra "ok"-knop).
      dateWrapper.appendChild(
        el("p", { class: "wnt-hint wnt-moment-line" }, [
          "Gekozen moment: ",
          // Dag+datum/tijd extra opvallend (vet en groter) gemaakt, zodat
          // het meteen opvalt als het formulier de datum automatisch heeft
          // doorgezet (Hans, 20 augustus 2026: "zou daar de dag en de datum
          // vet en groter kunnen worden weergegeven zodat het beter
          // opvalt").
          el("strong", { class: "wnt-chosen-moment", text: formatDateTime(getEffectiveDateTime()) }),
          " ",
          el("button", {
            type: "button",
            class: "wnt-info-button",
            text: "ⓘ",
            title: "Uitleg over het gekozen moment",
            "aria-label": "Uitleg over het gekozen moment",
            "aria-expanded": state.dateInfoOpen ? "true" : "false",
            onclick: () => {
              state.dateInfoOpen = !state.dateInfoOpen;
              render();
            },
          }),
        ])
      );
      if (state.dateInfoOpen) {
        dateWrapper.appendChild(
          el("p", { class: "wnt-hint wnt-info-text" }, [
            "We gaan standaard uit van minimaal 24 uur van tevoren boeken voor de scherpste prijs — pas gerust aan als u eerder wilt vertrekken.",
          ])
        );
      }
      container.appendChild(dateWrapper);

      // 6 oktober 2026 (Hans): het Vluchtnummer-veld staat bewust NA de
      // datum/tijd-keuze (de opzoeking gebruikt de ophaaldatum).
      // Vluchtnummer (Hans, 2 oktober 2026): verschijnt zodra de
      // OPHAALLOCATIE een luchthaven is (isAirportPickup, zelfde regel als
      // de bagageband-vraag in renderBaggageStep) -- dus alleen bij een
      // aankomende passagier die wordt opgehaald, niet bij een rit NAAR de
      // luchthaven. Bewust hier op stap 1 (niet in de bagage-stap): bij
      // "Heeft u bagage die mee moet?" -> "Nee" wordt de bagage-stap
      // overgeslagen (zie de knop hieronder), en het vluchtnummer is dan nog
      // steeds nodig.
      if (isAirportPickup()) {
        const flightWrapper = el("div", { class: "wnt-field" });
        flightWrapper.appendChild(el("label", { text: "Vluchtnummer" }));
        flightWrapper.appendChild(
          el("input", {
            type: "text",
            value: state.flightNumber,
            placeholder: "bijv. KL1234 of KL 1234",
            ...invalidAttrs("flightNumber"),
            oninput: (e) => {
              state.flightNumber = e.target.value;
              clearFieldError("flightNumber", e.target);
            },
            // Pas bij verlaten van het veld opzoeken (niet bij elke
            // toetsaanslag: bespaart aanroepen en laat de cursor met rust).
            onchange: () => {
              scheduleFlightRefresh(() => lookupFlightInfo());
            },
          })
        );
        flightWrapper.appendChild(
          el("p", { class: "wnt-hint" }, [
            "Zo kunnen we de vlucht volgen en op tijd klaarstaan, ook bij vertraging.",
          ])
        );
        const flightInfoNode = renderFlightInfo();
        if (flightInfoNode) flightWrapper.appendChild(flightInfoNode);
        const manualLandingNode = renderManualLanding();
        if (manualLandingNode) flightWrapper.appendChild(manualLandingNode);
        const flightErrorNode = fieldErrorNode("flightNumber");
        if (flightErrorNode) flightWrapper.appendChild(flightErrorNode);
        container.appendChild(flightWrapper);
      }

      // ---- Retourrit in dezelfde boeking (12 oktober 2026) ----
      // Eén keer betalen voor heen- en terugrit. De terugrit gebruikt de
      // omgekeerde adressen, dezelfde passagiers, bagage en voertuigcategorie;
      // wie iets anders wil (andere bagage of route) boekt twee losse ritten.
      const returnBox = el("div", { class: "wnt-field wnt-roundtrip" + (state.roundTrip ? " wnt-roundtrip-open" : "") });
      returnBox.appendChild(
        el("label", { class: "wnt-radio-label", for: "wnt-round-trip" }, [
          el("input", {
            type: "checkbox",
            id: "wnt-round-trip",
            checked: state.roundTrip ? "" : undefined,
            onchange: (e) => {
              state.roundTrip = e.target.checked;
              if (!state.roundTrip) {
                state.returnDateTime = null;
                state.returnFlightNumber = "";
                state.returnFlightInfo = null;
                state.returnFlightManualLanding = "";
                state.returnFlightManualOpen = false;
                state.returnTimeSteps = [];
              }
              render();
            },
          }),
          " Ook een retourrit boeken",
        ])
      );
      if (state.roundTrip) {
        const returnRoute = el("p", { class: "wnt-hint" });
        const returnFlightBox = el("div", { class: "wnt-field", hidden: !isReturnAirportPickup() });
        updateReturnBlock = () => {
          returnRoute.textContent = `Terugrit: van ${state.destination.text.trim() || "de bestemming"} naar ${state.origin.text.trim() || "het ophaaladres"}, met dezelfde reizigers, bagage en voertuigcategorie. Iets anders nodig? Boek dan twee losse ritten.`;
          returnFlightBox.hidden = !isReturnAirportPickup();
        };
        updateReturnBlock();
        returnBox.appendChild(returnRoute);

        const returnDateField = el("div", { class: "wnt-field" });
        returnDateField.appendChild(el("label", { text: "Datum en tijd terugrit" }));
        returnDateField.appendChild(
          el("input", {
            type: "datetime-local",
            id: "wnt-return-datetime",
            value: state.returnDateTime ? toDateTimeLocalValue(state.returnDateTime) : "",
            min: toDateTimeLocalValue(getEffectiveDateTime()),
            ...invalidAttrs("returnDateTime"),
            onchange: (e) => {
              clearFieldError("returnDateTime", e.target);
              state.returnDateTime = e.target.value ? localInputValueToDate(e.target.value) : null;
              state.returnTimeSteps = [];
              if (state.returnDateTime) {
                returnDateHint.textContent = `Gekozen: ${formatDateTime(state.returnDateTime)}`;
              } else {
                returnDateHint.textContent = "Kies een vaste datum en tijd. Weet u dat nog niet? Boek de terugrit dan later als losse rit.";
              }
              // Andere terugritdag/-tijd: de vluchtopzoeking en de landingscontrole
              // gelden per datum en ophaaltijd.
              scheduleFlightRefresh(() => {
                render();
                if (isReturnAirportPickup() && state.returnFlightNumber.trim()) lookupFlightInfo("return");
              });
            },
          })
        );
        const returnDateHint = el("p", {
          class: "wnt-hint",
          text: state.returnDateTime
            ? `Gekozen: ${formatDateTime(state.returnDateTime)}`
            : "Kies een vaste datum en tijd. Weet u dat nog niet? Boek de terugrit dan later als losse rit.",
        });
        returnDateField.appendChild(returnDateHint);
        const returnDateErrorNode = fieldErrorNode("returnDateTime");
        if (returnDateErrorNode) returnDateField.appendChild(returnDateErrorNode);
        returnBox.appendChild(returnDateField);

        returnFlightBox.appendChild(el("label", { text: "Vluchtnummer terugvlucht" }));
        returnFlightBox.appendChild(
          el("input", {
            type: "text",
            id: "wnt-return-flight",
            value: state.returnFlightNumber,
            placeholder: "bijv. KL1234 of KL 1234",
            ...invalidAttrs("returnFlight"),
            oninput: (e) => {
              state.returnFlightNumber = e.target.value;
              clearFieldError("returnFlight", e.target);
            },
            // Pas bij verlaten van het veld opzoeken (zoals bij de heenrit).
            onchange: () => {
              scheduleFlightRefresh(() => lookupFlightInfo("return"));
            },
          })
        );
        returnFlightBox.appendChild(
          el("p", { class: "wnt-hint", text: "De terugrit begint op de luchthaven. Zo kunnen we de vlucht volgen en op tijd klaarstaan, ook bij vertraging." })
        );
        const returnFlightInfoNode = renderFlightInfo("return");
        if (returnFlightInfoNode) returnFlightBox.appendChild(returnFlightInfoNode);
        const returnManualLandingNode = renderManualLanding("return");
        if (returnManualLandingNode) returnFlightBox.appendChild(returnManualLandingNode);
        const returnFlightErrorNode = fieldErrorNode("returnFlight");
        if (returnFlightErrorNode) returnFlightBox.appendChild(returnFlightErrorNode);
        returnBox.appendChild(returnFlightBox);
      }
      container.appendChild(returnBox);

      const passengersRow = el("div", { class: "wnt-row wnt-passengers-row" });
      passengersRow.appendChild(renderStepperField("Aantal volwassenen", state.passengerCount, 1, 8, (v) => (state.passengerCount = v)));
      passengersRow.appendChild(renderStepperField("Aantal kinderen", state.childCount, 0, 8, (v) => (state.childCount = v)));
      container.appendChild(passengersRow);

      // "Heeft u bagage?" (Hans, 19 augustus 2026, na zijn eigen eerste test
      // met de widget): zo hoeven klanten zonder bagage niet eerst door de
      // hele bagage-stap heen, met alles op "0 stuks"/"geen" -- die stap
      // wordt dan gewoon overgeslagen (zie de knop hieronder). Standaard op
      // "Ja" (dus standaard nog steeds de bagage-stap tonen, zoals nu al),
      // zodat er niets verandert totdat de klant hier bewust "Nee" kiest.
      const baggageQuestionWrapper = el("div", { class: "wnt-field" });
      baggageQuestionWrapper.appendChild(el("label", { text: "Heeft u bagage die mee moet?" }));
      const baggageSegments = el("div", { class: "wnt-segmented" });
      [
        { value: true, label: "Ja" },
        { value: false, label: "Nee" },
      ].forEach((opt) => {
        const radioId = `wnt-has-baggage-${opt.value}`;
        baggageSegments.appendChild(
          el("label", { class: "wnt-segment" + (state.hasBaggage === opt.value ? " wnt-segment-active" : ""), for: radioId }, [
            el("input", {
              type: "radio",
              id: radioId,
              name: "wnt-has-baggage",
              checked: state.hasBaggage === opt.value ? "" : undefined,
              onchange: () => {
                state.hasBaggage = opt.value;
                // Bug (Hans, 2 september 2026): vult iemand eerst bagage
                // in bij stap 2, gaat daarna terug naar stap 1 en kiest hier
                // alsnog "Nee", dan bleven baggageCounts/specialBaggageId
                // van de eerdere invoer gewoon staan -- de bagage-stap
                // wordt dan wel overgeslagen, maar de oude aantallen werden
                // nog steeds meegestuurd naar de prijs-/bagagecheck, met
                // als gevolg dat er onterecht voertuigen als "niet
                // beschikbaar" werden getoond terwijl de klant net had
                // aangegeven geen bagage mee te nemen. "Nee" moet dus altijd
                // ook echt terug naar de neutrale standaardwaarde, niet
                // alleen de stap overslaan.
                if (state.hasBaggage === false) {
                  resetBaggageSelections();
                }
                // Wél opnieuw renderen (in tegenstelling tot bij het typen
                // in een tekstveld): dit is een discrete klik, geen
                // doorlopende invoer, en de knoptekst hieronder ("Verder
                // naar bagage" vs. "Bekijk prijzen") hangt hiervan af.
                render();
              },
            }),
            opt.label,
          ])
        );
      });
      baggageQuestionWrapper.appendChild(baggageSegments);
      container.appendChild(baggageQuestionWrapper);

      container.appendChild(
        el("button", {
          type: "button",
          class: "wnt-button wnt-button-primary",
          text: state.hasBaggage === false ? (state.submitting ? "Bezig…" : "Bekijk prijzen") : "Verder naar bagage",
          disabled: state.submitting ? "" : undefined,
          onclick: () => {
            // Alle problemen tegelijk tonen, elk bij het eigen veld (14 oktober 2026).
            const errors = [];
            if (!state.origin.text.trim()) {
              errors.push(["origin", "Vul het ophaaladres in."]);
            } else if (!isFieldConfirmed(state.origin)) {
              // Zie isFieldConfirmed hierboven: een adres moet uit de
              // voorgestelde lijst gekozen zijn (of exact overeenkomen), zodat
              // we zeker weten dat het een geldig, door Google herkend adres is.
              errors.push(["origin", "Dit adres herkennen we niet. Typ het opnieuw en kies een adres uit de lijst die verschijnt."]);
            }
            if (!state.destination.text.trim()) {
              errors.push(["destination", "Vul de bestemming in."]);
            } else if (!isFieldConfirmed(state.destination)) {
              errors.push(["destination", "Deze bestemming herkennen we niet. Typ hem opnieuw en kies een adres uit de lijst die verschijnt."]);
            }
            // Vluchtnummer verplicht bij een luchthaven-ophaalrit (Hans, 2
            // oktober 2026, expliciete keuze: "Verplicht veld" i.p.v. optioneel).
            if (isAirportPickup() && !state.flightNumber.trim()) {
              errors.push(["flightNumber", "Vul uw vluchtnummer in, zodat we de vlucht kunnen volgen en op tijd voor u klaarstaan."]);
            } else {
              // Ophaaltijd vóór de landing: eerst aanpassen (rode knop) voordat
              // de klant verder kan.
              const conflictLanding = landingAfterPickup();
              if (conflictLanding) {
                errors.push([
                  "flightNumber",
                  `Uw vlucht landt om ${formatClock(conflictLanding.toISOString())}, na uw gekozen ophaaltijd. Gebruik de rode knop "Ophaaltijd aanpassen aan de landing" of kies zelf een later tijdstip.`,
                  () => !!landingAfterPickup(),
                ]);
              }
            }
            // Retourrit (12 oktober 2026): vaste datum en tijd verplicht, later dan
            // de heenrit, en bij een terugrit vanaf een luchthaven het vluchtnummer.
            if (state.roundTrip) {
              if (!state.returnDateTime) {
                errors.push(["returnDateTime", "Kies de datum en tijd van de terugrit, of haal het vinkje bij \"Ook een retourrit boeken\" weg."]);
              } else if (state.returnDateTime.getTime() <= getEffectiveDateTime().getTime()) {
                errors.push(["returnDateTime", "De terugrit moet later zijn dan de heenrit. Controleer de datum en tijd van de terugrit."]);
              }
              if (isReturnAirportPickup() && !state.returnFlightNumber.trim()) {
                errors.push(["returnFlight", "Vul het vluchtnummer van uw terugvlucht in, zodat we de vlucht kunnen volgen en op tijd voor u klaarstaan."]);
              } else {
                const returnConflictLanding = landingAfterPickup("return");
                if (returnConflictLanding) {
                  errors.push([
                    "returnFlight",
                    `Uw terugvlucht landt om ${formatClock(returnConflictLanding.toISOString())}, na de gekozen ophaaltijd van de terugrit. Gebruik de rode knop "Ophaaltijd aanpassen aan de landing" of kies zelf een later tijdstip.`,
                    () => !!landingAfterPickup("return"),
                  ]);
                }
              }
            }
            if (!showFieldErrors(errors)) return;
            state.fieldErrors = {};
            if (state.hasBaggage === false) {
              // Geen bagage-stap nodig. Extra zekerheid (naast de reset in
              // de onchange-handler hierboven, zie resetBaggageSelections):
              // ook hier nog eens expliciet terugzetten voor het geval
              // baggageCounts/specialBaggageId via een ander pad toch nog
              // een oude waarde zouden hebben -- zo kan er nooit meer
              // eerder ingevulde bagage worden meegeteld terwijl de klant
              // hier "Nee" heeft gekozen. Bij een luchthavenrit is "geen
              // bagage" ook meteen het antwoord op de bagageband-vraag (zie
              // renderBaggageStep) -- die stap wordt hier overgeslagen, dus
              // die vullen we hier vast zelf in, in plaats van de chauffeur
              // zonder enig antwoord te laten.
              resetBaggageSelections();
              if (isAirportPickup() && !state.airportBaggageAnswer) {
                state.airportBaggageAnswer = "handbagage";
              }
              fetchPrice();
              return;
            }
            state.step = "baggage";
            render();
          },
        })
      );

      return container;
    }

    // "ca. 85 × 55 × 35 cm" of null als er geen (volledige) afmetingen zijn.
    function dimensionsLabel(type) {
      const d = type && type.dimensionsCm;
      if (!d || !(d.l > 0) || !(d.w > 0) || !(d.h > 0)) return null;
      return `ca. ${d.l} × ${d.w} × ${d.h} cm`;
    }

    function renderStepperField(labelText, value, min, max, onChange, extraText) {
      const wrapper = el("div", { class: "wnt-field wnt-stepper" });
      wrapper.appendChild(
        el("label", {}, extraText ? [labelText, " ", el("span", { class: "wnt-dimensions", text: `(${extraText})` })] : [labelText])
      );
      const valueLabel = el("span", { class: "wnt-stepper-value", text: String(value) });
      wrapper.appendChild(
        el("div", { class: "wnt-stepper-controls" }, [
          el("button", {
            type: "button",
            class: "wnt-stepper-button",
            text: "−",
            onclick: () => {
              if (value > min) {
                onChange(value - 1);
                render();
              }
            },
          }),
          valueLabel,
          el("button", {
            type: "button",
            class: "wnt-stepper-button",
            text: "+",
            onclick: () => {
              if (value < max) {
                onChange(value + 1);
                render();
              }
            },
          }),
        ])
      );
      return wrapper;
    }

    function renderBaggageStep() {
      const container = el("div", { class: "wnt-step" });
      container.appendChild(el("h2", { text: "Bagage" }));
      // 9 oktober 2026 (Hans): afmetingen (l x b x h in cm) bij het bagagetype,
      // zodat de klant weet welke koffermaat erbij hoort. Alleen als ze in
      // /admin zijn ingevuld (bv. niet bij een rug-/handtas).
      const types = state.config.baggageTypes || [];
      const showDimensions = types.some((t) => dimensionsLabel(t));
      container.appendChild(
        el("p", { class: "wnt-hint" }, [
          "Zo weten we zeker dat we met een voertuig komen waar alle bagage in past." +
            (showDimensions ? " Afmetingen zijn lengte × breedte × hoogte, bij benadering." : ""),
        ])
      );

      types.forEach((type) => {
        container.appendChild(
          renderStepperField(
            type.name,
            state.baggageCounts[type.id] || 0,
            0,
            10,
            (v) => {
              state.baggageCounts[type.id] = v;
            },
            dimensionsLabel(type)
          )
        );
      });

      const specialWrapper = el("div", { class: "wnt-field" });
      specialWrapper.appendChild(el("label", { text: "Bijzondere bagage" }));
      const select = el("select", {
        onchange: (e) => {
          state.specialBaggageId = e.target.value;
          // Volledige render, zodat de vraag "Bij aankomst op de luchthaven"
          // (zie shouldAskAirportBaggageQuestion) meteen verdwijnt/verschijnt
          // zodra bijzondere bagage wordt gekozen of weer op "geen" gezet.
          render();
        },
      });
      (state.config.specialBaggageOptions || []).forEach((option) => {
        const priceLabel = option.free ? "gratis" : `+${euro(option.surchargeEuro)}`;
        select.appendChild(
          el("option", { value: option.id, selected: option.id === state.specialBaggageId ? "" : undefined }, [
            `${option.name} (${priceLabel})`,
          ])
        );
      });
      specialWrapper.appendChild(select);
      container.appendChild(specialWrapper);

      if (shouldAskAirportBaggageQuestion()) {
        const airportWrapper = el("div", { class: "wnt-field" });
        airportWrapper.appendChild(el("label", { text: "Bij aankomst op de luchthaven" }));
        const options = [
          { value: "ruimbagage", label: "Ik moet bagage van de bagageband ophalen" },
          { value: "handbagage", label: "Ik heb alleen handbagage bij me" },
        ];
        options.forEach((opt) => {
          const radioId = `wnt-airport-${opt.value}`;
          const label = el("label", { class: "wnt-radio-label", for: radioId }, [
            el("input", {
              type: "radio",
              id: radioId,
              name: "wnt-airport-baggage",
              checked: state.airportBaggageAnswer === opt.value ? "" : undefined,
              onchange: () => {
                state.airportBaggageAnswer = opt.value;
                clearFieldError("airportBaggage");
              },
            }),
            " " + opt.label,
          ]);
          airportWrapper.appendChild(label);
        });
        airportWrapper.appendChild(
          el("p", { class: "wnt-hint" }, ["Zo kunnen we beter inschatten hoe laat u daadwerkelijk buiten staat."])
        );
        const airportErrorNode = fieldErrorNode("airportBaggage");
        if (airportErrorNode) airportWrapper.appendChild(airportErrorNode);
        container.appendChild(airportWrapper);
      }

      if (state.priceError) {
        container.appendChild(el("p", { class: "wnt-error" }, [String(state.priceError)]));
      }

      const buttonRow = el("div", { class: "wnt-row wnt-button-row" });
      buttonRow.appendChild(
        el("button", {
          type: "button",
          class: "wnt-button wnt-button-secondary",
          text: "Vorige",
          onclick: () => {
            state.step = "ride";
            render();
          },
        })
      );
      buttonRow.appendChild(
        el("button", {
          type: "button",
          class: "wnt-button wnt-button-primary",
          text: state.submitting ? "Bezig…" : "Bekijk prijzen",
          disabled: state.submitting ? "" : undefined,
          onclick: () => {
            // Bug (Hans, 2 september 2026): de vraag "Bij aankomst op de
            // luchthaven" werd wel getoond zolang er nog geen grote
            // ruimbagage was opgegeven (zie shouldAskAirportBaggageQuestion
            // hierboven -- bewust ook zichtbaar bij alleen handbagage,
            // want dat is precies het twijfelgeval), maar was niet
            // verplicht: de klant kon zonder antwoord gewoon doorklikken
            // naar de prijzen. Net als bij de adresvelden op stap 1
            // (isFieldConfirmed hierboven) blokkeren we nu het doorgaan
            // zolang deze vraag zichtbaar is én nog onbeantwoord.
            if (shouldAskAirportBaggageQuestion() && !state.airportBaggageAnswer) {
              showFieldErrors([
                ["airportBaggage", "Kies hier uw antwoord, zodat we uw wachttijd na aankomst goed kunnen inschatten."],
              ]);
              return;
            }
            fetchPrice();
          },
        })
      );
      container.appendChild(buttonRow);

      return container;
    }

    // Generieke auto-icoon (inline SVG) als er voor een voertuigcategorie
    // nog geen `imageUrl` is ingesteld in het beheerscherm (19 augustus
    // 2026, naar aanleiding van Hans' derde testronde: "een afbeelding of
    // icoon van het type voertuig"). Zo staat er nooit een kapot
    // afbeeldingsicoontje op de voertuigkaart.
    const GENERIC_VEHICLE_ICON_SVG =
      '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11" />' +
      '<rect x="3" y="11" width="18" height="6" rx="2" /><circle cx="7.5" cy="17.5" r="1.5" /><circle cx="16.5" cy="17.5" r="1.5" /></svg>';

    function renderVehicleImage(vehicle) {
      if (vehicle.imageUrl) {
        return el("img", {
          class: "wnt-vehicle-image",
          src: vehicle.imageUrl,
          alt: vehicle.name,
          // Als de geconfigureerde URL toch niet laadt, val terug op het
          // generieke icoon in plaats van een kapot-plaatje-icoontje te tonen.
          onerror: (e) => {
            const fallback = el("div", { class: "wnt-vehicle-image wnt-vehicle-icon", html: GENERIC_VEHICLE_ICON_SVG });
            e.target.replaceWith(fallback);
          },
        });
      }
      return el("div", { class: "wnt-vehicle-image wnt-vehicle-icon", html: GENERIC_VEHICLE_ICON_SVG });
    }

    // 10 oktober 2026 (Hans' testpanel-idee): verwachte aankomsttijd met de
    // gebruikelijke drukte op het gekozen ophaalmoment. Alleen informatie --
    // de prijs verandert er niet door. Omdat een klant hieraan verwachtingen
    // kan ontlenen staat de vrijwaring bewust ALTIJD zichtbaar direct onder
    // de tijd (niet achter een ⓘ), en wordt er één "ca."-tijdstip getoond.
    function renderEstimatedArrival(iso, pickupDate, label, withDisclaimer) {
      if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
      const pickup = (pickupDate || getEffectiveDateTime()).toISOString();
      const sameDay =
        new Intl.DateTimeFormat("nl-NL", { dateStyle: "short", timeZone: "Europe/Amsterdam" }).format(new Date(pickup)) ===
          new Intl.DateTimeFormat("nl-NL", { dateStyle: "short", timeZone: "Europe/Amsterdam" }).format(new Date(iso));
      const when = sameDay ? formatClock(iso) : formatDayAndClock(iso);
      // 14 oktober 2026 (Hans): de lange vrijwaring staat niet meer altijd in
      // beeld maar achter een ⓘ-knop met het woord "Schatting!!!" (zoals de
      // uitleg op stap 1). Het woord zelf blijft altijd zichtbaar naast de
      // tijd, de volledige uitleg klapt inline open.
      const infoButton = el("button", {
        type: "button",
        class: "wnt-info-button wnt-arrival-info-button",
        title: "Uitleg over de verwachte aankomsttijd",
        "aria-label": "Uitleg over de verwachte aankomsttijd",
        "aria-expanded": state.arrivalInfoOpen ? "true" : "false",
        onclick: () => {
          state.arrivalInfoOpen = !state.arrivalInfoOpen;
          render();
        },
      }, ["ⓘ Schatting!!!"]);
      return el("div", { class: "wnt-arrival" }, [
        el("p", { class: "wnt-arrival-line" }, [label || "Verwachte aankomst: ", el("strong", { text: `ca. ${when}` }), " ", infoButton]),
        withDisclaimer === false || !state.arrivalInfoOpen
          ? null
          : el("p", { class: "wnt-arrival-disclaimer" }, [
              "Dit is een schatting op basis van de gebruikelijke drukte op het gekozen tijdstip. De werkelijke aankomsttijd kan afwijken, bijvoorbeeld door files, weer of wegwerkzaamheden. Aan deze schatting kunnen geen rechten worden ontleend. De prijs blijft ongewijzigd.",
            ]),
      ]);
    }

    function renderAppliedSurcharges(price, prefix) {
      // Een toeslag met een negatief bedrag (bijv. -15%) is in feite een
      // korting: die tonen we apart als "inclusief korting" (14 oktober 2026,
      // Hans: de korting werd verrekend maar er stond geen reden bij).
      const all = ((price && price.appliedSurcharges) || []).filter(
        (item) => item && item.name && Number.isFinite(item.amountEuro) && Math.abs(item.amountEuro) >= 0.005
      );
      const surcharges = all.filter((item) => item.amountEuro > 0);
      const reductions = all.filter((item) => item.amountEuro < 0);
      if (!surcharges.length && !reductions.length) return null;
      const sentences = [];
      if (surcharges.length) {
        const parts = surcharges.map((item) => `${item.name} (+${euro(item.amountEuro)})`);
        sentences.push(`${surcharges.length === 1 ? "toeslag" : "toeslagen"}: ${parts.join(", ")}`);
      }
      if (reductions.length) {
        const parts = reductions.map((item) => `${item.name} (\u2212${euro(Math.abs(item.amountEuro))})`);
        sentences.push(`${reductions.length === 1 ? "korting" : "kortingen"}: ${parts.join(", ")}`);
      }
      const lead = prefix ? prefix + ": inclusief " : "Inclusief ";
      return el("p", {
        class: "wnt-vehicle-surcharges",
        text: lead + sentences.join(" \u00b7 inclusief "),
      });
    }

    // 11 oktober 2026: persoonlijke kortingscode op de voertuigkeuze. Een
    // compacte link die een invulveld opent; na "Toepassen" vraagt de widget
    // de prijzen opnieuw op (de server rekent de korting uit en bevestigt de
    // code). Een code die niet (meer) geldt geeft een duidelijke melding.
    function discountValueText(discount) {
      return discount.kind === "percent" ? `${String(discount.value).replace(".", ",")}% korting` : `${euro(discount.value)} korting`;
    }

    function renderDiscountBox() {
      const box = el("div", { class: "wnt-discount" });

      if (state.discountApplied) {
        box.appendChild(
          el("p", { class: "wnt-discount-applied" }, [
            "✓ Kortingscode ",
            el("strong", { text: formatDiscountCode(state.discountApplied.code) }),
            ` toegepast (${discountValueText(state.discountApplied)}). `,
            el("button", {
              type: "button",
              class: "wnt-link-button",
              text: "Verwijderen",
              disabled: state.submitting ? "" : undefined,
              onclick: removeDiscount,
            }),
          ])
        );
        return box;
      }

      if (!state.discountOpen && !state.discountError) {
        box.appendChild(
          el("button", {
            type: "button",
            class: "wnt-link-button",
            text: "Heeft u een kortingscode?",
            onclick: () => {
              state.discountOpen = true;
              render();
              const input = document.querySelector(".wnt-discount-input");
              if (input) input.focus();
            },
          })
        );
        return box;
      }

      const row = el("div", { class: "wnt-discount-row" });
      row.appendChild(
        el("input", {
          type: "text",
          class: "wnt-discount-input",
          value: state.discountInput,
          placeholder: "Uw kortingscode",
          autocomplete: "off",
          autocapitalize: "characters",
          spellcheck: "false",
          maxlength: "20",
          "aria-label": "Kortingscode",
          oninput: (e) => {
            state.discountInput = e.target.value;
          },
          onkeydown: (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyDiscountInput();
            }
          },
        })
      );
      row.appendChild(
        el("button", {
          type: "button",
          class: "wnt-button wnt-button-secondary",
          text: state.submitting ? "Bezig…" : "Toepassen",
          disabled: state.submitting ? "" : undefined,
          onclick: applyDiscountInput,
        })
      );
      box.appendChild(row);
      if (state.discountError) box.appendChild(el("p", { class: "wnt-error", text: state.discountError }));
      return box;
    }

    // Drie regels (geen doorgestreepte "oude" prijs): prijs, korting, totaal.
    function renderDiscountedPrice(price) {
      const line = (label, value, strong) =>
        el("div", { class: "wnt-price-line" + (strong ? " wnt-price-line-total" : "") }, [
          el("span", { text: label }),
          el("span", { text: value }),
        ]);
      return el("div", { class: "wnt-vehicle-price-breakdown" }, [
        line("Prijs", euro(price.originalTotalEuro)),
        line(`Korting (${formatDiscountCode(price.discount.code)})`, `− ${euro(price.discount.amountEuro)}`),
        line("Totaal", euro(price.totalEuro), true),
      ]);
    }

    // Retourboeking (12 oktober 2026): prijs van heen- en terugrit en het
    // totaal (met eventuele korting over het geheel). De bedragen komen van de
    // server (vehicle.roundTrip); de widget rekent niets zelf uit.
    function renderRoundTripPrice(vehicle) {
      const rt = vehicle.roundTrip;
      const line = (label, value, strong) =>
        el("div", { class: "wnt-price-line" + (strong ? " wnt-price-line-total" : "") }, [
          el("span", { text: label }),
          el("span", { text: value }),
        ]);
      const outbound = vehicle.price.originalTotalEuro != null ? vehicle.price.originalTotalEuro : vehicle.price.totalEuro;
      const back = vehicle.returnTrip.price;
      const backOriginal = back.originalTotalEuro != null ? back.originalTotalEuro : back.totalEuro;
      const lines = [line("Heenrit", euro(outbound)), line("Terugrit", euro(backOriginal))];
      if (rt.discount) lines.push(line(`Korting (${formatDiscountCode(rt.discount.code)})`, `− ${euro(rt.discount.amountEuro)}`));
      lines.push(line("Totaal", euro(rt.totalEuro), true));
      return el("div", { class: "wnt-vehicle-price-breakdown" }, lines);
    }

    // 14 oktober 2026 (UX-ronde): een compacte samenvatting van wat de klant
    // tot nu toe koos, boven "Voertuig" en "Gegevens", zodat hij steeds ziet
    // wat hij boekt. `withVehicle`: ook het gekozen voertuig tonen (stap 4).
    function describePassengers() {
      const adults = state.passengerCount;
      const kids = state.childCount;
      const parts = [`${adults} ${adults === 1 ? "volwassene" : "volwassenen"}`];
      if (kids > 0) parts.push(`${kids} ${kids === 1 ? "kind" : "kinderen"}`);
      return parts.join(", ");
    }

    function renderTripSummary(withVehicle) {
      const from = state.origin.text.trim();
      const to = state.destination.text.trim();
      const rows = [];
      rows.push(["Van", from]);
      rows.push(["Naar", to]);
      if (state.roundTrip && state.returnDateTime) {
        rows.push(["Heenrit", formatDateTime(getEffectiveDateTime())]);
        rows.push(["Terugrit", formatDateTime(state.returnDateTime)]);
      } else {
        rows.push(["Wanneer", formatDateTime(getEffectiveDateTime())]);
      }
      rows.push(["Reizigers", describePassengers()]);
      rows.push(["Bagage", state.hasBaggage === false ? "Geen bagage" : describeBaggageForSummary()]);
      if (withVehicle) {
        const vehicle = state.priceResult && (state.priceResult.vehicles || []).find((v) => v.vehicleId === state.selectedVehicleId);
        if (vehicle) rows.push(["Voertuig", [vehicle.name, vehicle.model].filter(Boolean).join(" - ")]);
      }
      const list = el("dl", { class: "wnt-trip-summary-list" });
      rows.forEach(([label, value]) => {
        list.appendChild(el("dt", { text: label }));
        const lines = Array.isArray(value) ? value : [value];
        list.appendChild(el("dd", {}, lines.map((line) => el("span", { class: "wnt-trip-summary-line", text: line }))));
      });
      return el("div", { class: "wnt-trip-summary" }, [
        el("div", { class: "wnt-trip-summary-head" }, [
          el("strong", { text: state.roundTrip ? "Uw ritten" : "Uw rit" }),
          el("button", {
            type: "button",
            class: "wnt-link-button",
            text: "Wijzigen",
            onclick: () => {
              state.step = "ride";
              render();
            },
          }),
        ]),
        list,
      ]);
    }

    function renderVehiclesStep() {
      const container = el("div", { class: "wnt-step" });
      container.appendChild(el("h2", { text: "Kies uw voertuig" }));
      container.appendChild(renderTripSummary(false));

      if (state.priceResult && state.priceResult.route) {
        container.appendChild(
          el("p", { class: "wnt-hint" }, [
            `Afstand: ${state.priceResult.route.distanceKm.toFixed(1)} km, rijtijd: ${Math.round(
              state.priceResult.route.durationMinutes
            )} min.`,
          ])
        );
        const isRound = Boolean(state.roundTrip && state.priceResult.returnRoute);
        const arrivalNode = renderEstimatedArrival(
          state.priceResult.route.estimatedArrival,
          getEffectiveDateTime(),
          isRound ? "Verwachte aankomst heenrit: " : undefined,
          !isRound
        );
        if (arrivalNode) container.appendChild(arrivalNode);
        if (isRound) {
          const back = state.priceResult.returnRoute;
          container.appendChild(
            el("p", { class: "wnt-hint" }, [
              `Terugrit op ${formatDateTime(state.returnDateTime)}. Afstand: ${back.distanceKm.toFixed(1)} km, rijtijd: ${Math.round(back.durationMinutes)} min.`,
            ])
          );
          const backArrival = renderEstimatedArrival(back.estimatedArrival, state.returnDateTime, "Verwachte aankomst terugrit: ");
          if (backArrival) container.appendChild(backArrival);
        }
      }

      // 2 september 2026 (Hans: "volgens mij werkt het berekenen van de
      // afwijkende bagage nog niet goed" -- bleek bij uitzoeken geen
      // rekenfout: checkVehicleFit telt een bagagetype/bijzonder item bewust
      // NIET mee zolang de inhoudsmaat ervan nog niet is ingevuld via
      // /admin (zie baggageCheck.js), zodat er nooit een verzonnen 0 L
      // gebruikt wordt -- de server stuurt daar per voertuig al een
      // duidelijke waarschuwing bij (vehicle.baggage.warnings), maar die
      // werd tot nu toe nergens getoond, waardoor het leek alsof de bagage
      // gewoon "paste" zonder duidelijke reden. Deze waarschuwingen zijn
      // voor élk voertuig identiek (dezelfde opgegeven bagage), dus hier
      // gededupliceerd één keer boven de voertuigkaarten getoond, in
      // plaats van drie keer identiek onder elke kaart apart.
      if (state.priceResult && state.priceResult.vehicles) {
        const baggageWarnings = [];
        state.priceResult.vehicles.forEach((vehicle) => {
          (vehicle.baggage?.warnings || []).forEach((w) => {
            if (!baggageWarnings.includes(w)) baggageWarnings.push(w);
          });
        });
        baggageWarnings.forEach((w) => container.appendChild(el("p", { class: "wnt-hint", text: w })));
      }

      container.appendChild(renderDiscountBox());

      const grid = el("div", { class: "wnt-vehicle-grid" });
      (state.priceResult ? state.priceResult.vehicles : []).forEach((vehicle) => {
        const isSelected = state.selectedVehicleId === vehicle.vehicleId;
        const card = el("div", {
          class: "wnt-vehicle-card" + (vehicle.available ? "" : " wnt-vehicle-unavailable") + (isSelected ? " wnt-vehicle-selected" : ""),
        });
        card.appendChild(renderVehicleImage(vehicle));
        card.appendChild(el("h3", { text: vehicle.name }));
        card.appendChild(el("p", { class: "wnt-vehicle-model", text: vehicle.model }));
        const roundTripPrices = Boolean(state.roundTrip && vehicle.roundTrip && vehicle.price && vehicle.returnTrip && vehicle.returnTrip.price);
        if (roundTripPrices) {
          card.appendChild(renderRoundTripPrice(vehicle));
          const outSurcharges = renderAppliedSurcharges(vehicle.price, "Heenrit");
          if (outSurcharges) card.appendChild(outSurcharges);
          const backSurcharges = renderAppliedSurcharges(vehicle.returnTrip.price, "Terugrit");
          if (backSurcharges) card.appendChild(backSurcharges);
        } else if (vehicle.price && !(state.roundTrip && vehicle.returnTrip)) {
          if (vehicle.price.discount) {
            card.appendChild(renderDiscountedPrice(vehicle.price));
          } else {
            card.appendChild(el("p", { class: "wnt-vehicle-price", text: euro(vehicle.price.totalEuro) }));
          }
          // 10 oktober 2026 (Hans): laat zien waarom de prijs hoger is dan
          // normaal -- alle toegepaste toeslagen (spits, nacht, weekend,
          // feestdag, bijzondere bagage, boeking binnen 24 uur) met naam en
          // bedrag. De naam is de naam uit /admin; de notitie daar is intern.
          const surchargeNode = renderAppliedSurcharges(vehicle.price);
          if (surchargeNode) card.appendChild(surchargeNode);
        }
        if (!vehicle.available) {
          // 30 september 2026: de capaciteitscheck (vehicle.capacity.full,
          // zie startdocument "Capaciteitscheck gebouwd") kan een voertuig
          // ook onbeschikbaar maken terwijl de bagage prima past en de prijs
          // gewoon berekend kon worden -- zonder deze tak viel dat geval
          // ten onrechte terug op de generieke priceError-melding hieronder.
          //
          // 1 oktober 2026 (Hans): capaciteit wordt bewust VOOR bagage
          // gecheckt. Reden: bij een volgeboekte categorie helpt het de
          // klant niet om de bagage aan te passen (bijv. minder stuks) --
          // die auto is sowieso niet beschikbaar, ongeacht de bagagekeuze.
          // Zou bagage eerst getoond worden, dan kan dat ten onrechte de
          // indruk wekken dat een andere bagagekeuze het zou oplossen.
          let reasonText;
          // Retourboeking: ook de terugrit kan vol zijn; de melding zegt welke rit.
          const outboundFull = Boolean(vehicle.capacity && vehicle.capacity.full);
          const returnFull = Boolean(state.roundTrip && vehicle.returnTrip && vehicle.returnTrip.capacity && vehicle.returnTrip.capacity.full);
          const legPrefix = state.roundTrip ? (outboundFull ? "Heenrit: " : "Terugrit: ") : "";
          const fullLeg = outboundFull
            ? { capacity: vehicle.capacity, adopt: (d) => adoptPickupTime(d, "capacity") }
            : returnFull
              ? { capacity: vehicle.returnTrip.capacity, adopt: (d) => adoptReturnPickupTime(d) }
              : null;
          if (fullLeg) {
            reasonText = legPrefix + (fullLeg.capacity.reason || "Dit voertuigtype is voor het gekozen tijdstip helaas al volgeboekt.");
          } else if (!vehicle.baggage.fits) {
            reasonText = vehicle.baggage.reason || "Bagage past niet in dit voertuig.";
          } else {
            reasonText = vehicle.priceError || "Prijs kon niet berekend worden.";
          }
          card.appendChild(el("p", { class: "wnt-vehicle-reason" }, [reasonText]));
          // 5 oktober 2026 (Hans): is een categorie vol, dan geeft de server
          // (vehicle.capacity.nextAvailableAt) het eerste LATERE tijdstip
          // waarop er weer een auto vrij is. Bewust alleen later, nooit
          // eerder (een eerder moment kan onder de 24-uursgrens vallen).
          // De knop neemt dat tijdstip over en rekent de prijs opnieuw uit
          // -- de prijs kan op dat moment anders zijn (nacht-/weekendtoeslag).
          if (fullLeg && fullLeg.capacity.nextAvailableAt) {
            const nextAt = new Date(fullLeg.capacity.nextAvailableAt);
            if (!isNaN(nextAt.getTime())) {
              card.appendChild(
                el("p", { class: "wnt-vehicle-next-available" }, [
                  "Wel beschikbaar vanaf ",
                  el("strong", { text: formatDateTime(nextAt) }),
                  ".",
                ])
              );
              card.appendChild(
                el("button", {
                  type: "button",
                  class: "wnt-button wnt-button-secondary",
                  text: "Kies dit tijdstip",
                  disabled: state.submitting,
                  onclick: () => {
                    fullLeg.adopt(nextAt);
                    fetchPrice();
                  },
                })
              );
            }
          }
        }
        if (vehicle.price && vehicle.price.warnings && vehicle.price.warnings.length) {
          vehicle.price.warnings.forEach((w) => card.appendChild(el("p", { class: "wnt-vehicle-warning", text: w })));
        }
        if (state.roundTrip && vehicle.returnTrip && vehicle.returnTrip.price && vehicle.returnTrip.price.warnings) {
          const shown = (vehicle.price && vehicle.price.warnings) || [];
          vehicle.returnTrip.price.warnings
            .filter((w) => !shown.includes(w))
            .forEach((w) => card.appendChild(el("p", { class: "wnt-vehicle-warning", text: `Terugrit: ${w}` })));
        }
        if (vehicle.available) {
          card.appendChild(
            el("button", {
              type: "button",
              class: "wnt-button wnt-button-primary",
              text: isSelected ? "Geselecteerd" : "Kies dit voertuig",
              onclick: () => {
                state.selectedVehicleId = vehicle.vehicleId;
                state.step = "details";
                render();
              },
            })
          );
        }
        grid.appendChild(card);
      });
      container.appendChild(grid);

      container.appendChild(
        el("button", {
          type: "button",
          class: "wnt-button wnt-button-secondary",
          text: "Vorige",
          onclick: () => {
            // Als de bagage-stap is overgeslagen (state.hasBaggage === false,
            // zie renderRideStep), dan bestaat die stap voor deze klant niet
            // -- "Vorige" moet dan terug naar het eerste scherm, niet naar
            // een bagage-pagina die de klant nooit gezien heeft.
            state.step = state.hasBaggage === false ? "ride" : "baggage";
            render();
          },
        })
      );

      return container;
    }

    function renderDetailsStep() {
      const container = el("div", { class: "wnt-step" });
      container.appendChild(el("h2", { text: "Uw gegevens" }));
      container.appendChild(renderTripSummary(true));

      // Invulhulp (14 oktober 2026): `autocomplete` laat de telefoon naam, e-mail
      // en nummer zelf invullen, `inputmode` toont het juiste toetsenbord.
      function textField(labelText, key, type, options) {
        const { hint, ...extra } = options || {};
        const wrapper = el("div", { class: "wnt-field" });
        wrapper.appendChild(el("label", { text: labelText, for: `wnt-passenger-${key}` }));
        wrapper.appendChild(
          el("input", {
            type: type || "text",
            id: `wnt-passenger-${key}`,
            name: key,
            value: state.passenger[key],
            required: "",
            ...extra,
            ...invalidAttrs(key),
            oninput: (e) => {
              state.passenger[key] = e.target.value;
              clearFieldError(key, e.target);
            },
          })
        );
        if (hint) wrapper.appendChild(el("p", { class: "wnt-hint", text: hint }));
        const errorNode = fieldErrorNode(key);
        if (errorNode) wrapper.appendChild(errorNode);
        return wrapper;
      }

      container.appendChild(textField("Voornaam", "firstName", "text", { autocomplete: "given-name" }));
      container.appendChild(textField("Achternaam", "lastName", "text", { autocomplete: "family-name" }));
      container.appendChild(textField("E-mailadres", "email", "email", { autocomplete: "email", inputmode: "email", autocapitalize: "off" }));
      container.appendChild(
        textField("Telefoonnummer", "phoneNumber", "tel", {
          autocomplete: "tel",
          inputmode: "tel",
          placeholder: "bijv. 06 12345678",
          hint: "Voor contact over uw rit. Een buitenlands nummer mag ook, met landcode (bijv. +49 151 1234567).",
        })
      );

      const noteWrapper = el("div", { class: "wnt-field" });
      noteWrapper.appendChild(el("label", { text: "Opmerking (optioneel)" }));
      noteWrapper.appendChild(
        el("textarea", {
          rows: "2",
          oninput: (e) => {
            state.note = e.target.value;
          },
          text: state.note,
        })
      );
      container.appendChild(noteWrapper);

      if (state.bookError) {
        container.appendChild(el("p", { class: "wnt-error" }, [String(state.bookError)]));
      }

      // Online betalen (8 oktober 2026): staat dat aan, dan betaalt de klant
      // eerst en wordt de rit pas daarna vastgelegd. Een korte uitleg vooraf,
      // zodat de doorverwijzing naar de betaalpagina geen verrassing is.
      const onlinePayment = state.config.onlinePayment || {};
      const selectedVehicle =
        state.priceResult && (state.priceResult.vehicles || []).find((v) => v.vehicleId === state.selectedVehicleId);
      // Retourboeking (12 oktober 2026): één bedrag voor heen- en terugrit.
      const roundTripTotal = state.roundTrip && selectedVehicle && selectedVehicle.roundTrip ? selectedVehicle.roundTrip : null;
      if (roundTripTotal && state.returnDateTime) {
        container.appendChild(
          el("p", { class: "wnt-hint", text: "U betaalt één keer voor beide ritten." })
        );
      }
      const totalToPay = roundTripTotal
        ? roundTripTotal.totalEuro
        : selectedVehicle && selectedVehicle.price
          ? selectedVehicle.price.totalEuro
          : null;
      const appliedDiscount = roundTripTotal ? roundTripTotal.discount : selectedVehicle && selectedVehicle.price ? selectedVehicle.price.discount : null;
      if (appliedDiscount) {
        container.appendChild(
          el("p", { class: "wnt-hint", text: `Kortingscode ${formatDiscountCode(appliedDiscount.code)} toegepast: − ${euro(appliedDiscount.amountEuro)}.` })
        );
      }
      const freeRide = totalToPay === 0;
      if (freeRide) {
        container.appendChild(
          el("p", { class: "wnt-hint", text: state.roundTrip ? "Met uw kortingscode zijn deze ritten gratis. U hoeft niets te betalen." : "Met uw kortingscode is deze rit gratis. U hoeft niets te betalen." })
        );
      }
      if (onlinePayment.enabled && !freeRide) {
        const onlyIdeal = totalToPay !== null && totalToPay <= (onlinePayment.lowAmountThresholdEuro || 0);
        container.appendChild(
          el("p", {
            class: "wnt-hint",
            text: onlyIdeal
              ? `U betaalt direct online met iDEAL | Wero. Na het bevestigen gaat u naar de beveiligde betaalpagina; ${state.roundTrip ? "uw ritten worden" : "uw rit wordt"} vastgelegd zodra de betaling is gelukt.`
              : `U betaalt direct online. Na het bevestigen gaat u naar de beveiligde betaalpagina, waar u uw betaalmethode kiest; ${state.roundTrip ? "uw ritten worden" : "uw rit wordt"} vastgelegd zodra de betaling is gelukt.`,
          })
        );
      }

      // Akkoord met de voorwaarden (14 oktober 2026): verplicht vinkje direct
      // boven de knop, met links naar beide pagina's in een nieuw tabblad.
      const termsField = el("div", { class: "wnt-field wnt-terms" });
      termsField.appendChild(
        el("label", { class: "wnt-terms-label", for: "wnt-terms" }, [
          el("input", {
            type: "checkbox",
            id: "wnt-terms",
            checked: state.termsAccepted ? "" : undefined,
            ...invalidAttrs("terms"),
            onchange: (e) => {
              state.termsAccepted = e.target.checked;
              if (e.target.checked) clearFieldError("terms", e.target);
            },
          }),
          el("span", {}, [
            "Ik ga akkoord met de ",
            el("a", { href: termsUrl, target: "_blank", rel: "noopener noreferrer", text: "algemene voorwaarden" }),
            " en heb het ",
            el("a", { href: privacyUrl, target: "_blank", rel: "noopener noreferrer", text: "privacy statement" }),
            " gelezen.",
          ]),
        ])
      );
      const termsErrorNode = fieldErrorNode("terms");
      if (termsErrorNode) termsField.appendChild(termsErrorNode);
      container.appendChild(termsField);

      const buttonRow = el("div", { class: "wnt-row wnt-button-row" });
      buttonRow.appendChild(
        el("button", {
          type: "button",
          class: "wnt-button wnt-button-secondary",
          text: "Vorige",
          onclick: () => {
            state.step = "vehicles";
            render();
          },
        })
      );
      buttonRow.appendChild(
        el("button", {
          type: "button",
          class: "wnt-button wnt-button-primary",
          text: state.submitting
            ? "Bezig…"
            : onlinePayment.enabled && !freeRide
              ? totalToPay !== null
                ? `Bevestig en betaal ${euro(totalToPay)}`
                : "Bevestig en betaal"
              : "Bevestig boeking",
          disabled: state.submitting ? "" : undefined,
          onclick: () => {
            const p = state.passenger;
            const errors = [];
            if (!p.firstName.trim()) errors.push(["firstName", "Vul uw voornaam in."]);
            if (!p.lastName.trim()) errors.push(["lastName", "Vul uw achternaam in."]);
            if (!p.email.trim()) errors.push(["email", "Vul uw e-mailadres in."]);
            else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email.trim())) errors.push(["email", "Dit e-mailadres lijkt niet te kloppen. Controleer het, bijvoorbeeld naam@voorbeeld.nl."]);
            if (!p.phoneNumber.trim()) errors.push(["phoneNumber", "Vul uw telefoonnummer in."]);
            else if (p.phoneNumber.replace(/\D/g, "").length < 6) errors.push(["phoneNumber", "Dit telefoonnummer lijkt te kort. Controleer het nummer."]);
            if (!state.termsAccepted) errors.push(["terms", "Vink aan dat u akkoord gaat met de algemene voorwaarden en het privacy statement om te kunnen boeken."]);
            if (!showFieldErrors(errors)) return;
            submitBooking();
          },
        })
      );
      container.appendChild(buttonRow);

      return container;
    }

    // 6 oktober 2026 (Hans): de bevestiging toont zelf de samenvatting van de
    // boeking, in plaats van alleen een link naar de (niet aanpasbare)
    // taxiID-pagina. De gegevens komen uit wat de klant zojuist heeft
    // ingevuld (state) en de bevestiging van de backend (bookResult).
    function formatLongDateTime(date) {
      return new Intl.DateTimeFormat("nl-NL", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Amsterdam",
      }).format(date);
    }

    function describeBaggageForSummary() {
      const parts = [];
      (state.config.baggageTypes || []).forEach((type) => {
        const count = state.baggageCounts[type.id] || 0;
        if (count > 0) parts.push(`${count}x ${type.name}`);
      });
      if (state.specialBaggageId && state.specialBaggageId !== "geen") {
        const option = (state.config.specialBaggageOptions || []).find((o) => o.id === state.specialBaggageId);
        parts.push(option ? option.name : state.specialBaggageId);
      }
      return parts.length ? parts.join(", ") : "Geen bagage";
    }

    // Samenvatting uit wat de klant zojuist invulde: alleen nog als terugval
    // voor het geval de backend (nog) geen `summary` meestuurt. Normaal komt
    // de samenvatting van de server (zie backend prepareBooking.js), zodat
    // hetzelfde scherm ook na een terugkeer van de betaalpagina te tonen is.
    function buildSummaryFromState(result) {
      const p = state.passenger;
      const vehicle = state.priceResult && (state.priceResult.vehicles || []).find((v) => v.vehicleId === state.selectedVehicleId);
      return {
        originAddress: state.origin.text,
        destinationAddress: state.destination.text,
        dateTime: getEffectiveDateTime().toISOString(),
        flightNumber:
          isAirportPickup() && state.flightNumber.trim()
            ? normalizeFlightNumberInput(state.flightNumber) || state.flightNumber.trim()
            : null,
        passengerCount: totalPassengerCount(),
        vehicleName: vehicle ? vehicle.name : null,
        vehicleModel: vehicle ? vehicle.model : null,
        baggage: describeBaggageForSummary(),
        note: state.note || null,
        name: `${p.firstName} ${p.lastName}`.trim(),
        phoneNumber: p.phoneNumber,
        email: p.email,
        totalEuro: result.price.totalEuro,
        discount: result.price.discount
          ? { code: result.price.discount.code, amountEuro: result.price.discount.amountEuro, originalTotalEuro: result.price.originalTotalEuro }
          : null,
      };
    }

    function renderSummaryView({ summary, rideNumber, reference, returnRideNumber, returnReference, warnings, paid }) {
      const container = el("div", { class: "wnt-step wnt-success" });
      const firstName = (summary.name || "").split(" ")[0];
      const back = summary.returnTrip || null;
      container.appendChild(el("h2", { text: back ? "Uw ritten zijn geboekt" : "Uw rit is geboekt" }));
      container.appendChild(
        el("p", {
          text: paid
            ? `Bedankt${firstName ? ", " + firstName : ""}! Uw betaling is ontvangen en uw boeking is bevestigd. Hieronder vindt u de gegevens van ${back ? "uw ritten" : "uw rit"}.`
            : `Bedankt${firstName ? ", " + firstName : ""}! Uw boeking is bevestigd. Hieronder vindt u de gegevens van ${back ? "uw ritten" : "uw rit"}.`,
        })
      );

      const rows = [];
      // Het ritnummer is het nummer dat ook in het taxiID-portaal staat, zodat een
      // centralist de rit kan opzoeken. Alleen als dat ontbreekt tonen we de korte
      // taxiID-referentie als terugval.
      // Bij een retourboeking heeft elke rit een eigen nummer.
      if (back) {
        if (rideNumber) rows.push(["Ritnummer heenrit", rideNumber]);
        else if (reference) rows.push(["Referentie heenrit", reference]);
        if (returnRideNumber) rows.push(["Ritnummer terugrit", returnRideNumber]);
        else if (returnReference) rows.push(["Referentie terugrit", returnReference]);
        if (summary.roundTripCode) rows.push(["Retourcode", summary.roundTripCode]);
      } else if (rideNumber) rows.push(["Ritnummer", rideNumber]);
      else if (reference) rows.push(["Referentie", reference]);
      rows.push([back ? "Heenrit: ophalen" : "Ophalen", summary.originAddress]);
      rows.push([back ? "Heenrit: bestemming" : "Bestemming", summary.destinationAddress]);
      rows.push([back ? "Heenrit: datum en tijd" : "Datum en tijd", formatLongDateTime(new Date(summary.dateTime))]);
      if (summary.flightNumber) rows.push([back ? "Heenrit: vluchtnummer" : "Vluchtnummer", summary.flightNumber]);
      if (back) {
        rows.push(["Terugrit: ophalen", back.originAddress]);
        rows.push(["Terugrit: bestemming", back.destinationAddress]);
        rows.push(["Terugrit: datum en tijd", formatLongDateTime(new Date(back.dateTime))]);
        if (back.flightNumber) rows.push(["Terugrit: vluchtnummer", back.flightNumber]);
      }
      rows.push(["Passagiers", String(summary.passengerCount)]);
      if (summary.vehicleName) rows.push(["Voertuig", [summary.vehicleName, summary.vehicleModel].filter(Boolean).join(" - ")]);
      rows.push(["Bagage", summary.baggage]);
      if (summary.note) rows.push(["Opmerking", summary.note]);
      rows.push(["Naam", summary.name]);
      rows.push(["Telefoonnummer", summary.phoneNumber]);
      rows.push(["E-mailadres", summary.email]);
      if (summary.discount) {
        rows.push(["Prijs zonder korting", euro(summary.discount.originalTotalEuro)]);
        rows.push([`Korting (${formatDiscountCode(summary.discount.code)})`, `− ${euro(summary.discount.amountEuro)}`]);
      } else if (back && Number.isFinite(summary.outboundTotalEuro) && Number.isFinite(back.totalEuro)) {
        rows.push(["Prijs heenrit", euro(summary.outboundTotalEuro)]);
        rows.push(["Prijs terugrit", euro(back.totalEuro)]);
      }
      rows.push([paid ? "Betaald" : "Totaalprijs", euro(summary.totalEuro)]);

      const list = el("dl", { class: "wnt-summary-list" });
      rows.forEach(([label, value]) => {
        const isTotal = label === "Totaalprijs" || label === "Betaald";
        list.appendChild(el("dt", { class: isTotal ? "wnt-summary-total" : undefined, text: label }));
        list.appendChild(el("dd", { class: isTotal ? "wnt-summary-total" : undefined, text: value }));
      });
      container.appendChild(el("div", { class: "wnt-summary" }, [list]));

      // Geen link naar de taxiID-ritpagina (Hans, 6 oktober 2026): die pagina
      // heeft een andere URL en opmaak dan onze website en wekt onrust bij
      // klanten, en annuleren door de klant is niet de bedoeling.
      container.appendChild(
        el("p", { class: "wnt-hint", text: back ? "Wilt u iets wijzigen aan uw ritten? Neem dan telefonisch contact met ons op." : "Wilt u iets wijzigen aan uw rit? Neem dan telefonisch contact met ons op." })
      );
      // Interne mededeling over de nog niet gekoppelde online betaling hoort
      // niet bij de klant; de overige waarschuwingen blijven staan.
      (warnings || [])
        .filter((w) => !/paymentMeta/i.test(w))
        .forEach((w) => container.appendChild(el("p", { class: "wnt-hint", text: w })));

      // 10 oktober 2026 (Hans): vanaf de bevestiging was er geen duidelijke
      // weg terug naar het beginscherm voor een volgende rit. De pagina wordt
      // opnieuw geladen op het adres zonder onze terugkeer-parameters
      // (?wnt_order=...), zodat het formulier helemaal schoon begint en de
      // pagina bovenaan staat.
      container.appendChild(
        el("button", {
          type: "button",
          class: "wnt-button wnt-button-primary wnt-new-booking",
          text: "Nog een rit boeken",
          onclick: () => {
            window.location.href = currentReturnUrl();
          },
        })
      );
      return container;
    }

    function renderSuccessStep() {
      const result = state.bookResult;
      return renderSummaryView({
        summary: result.summary || buildSummaryFromState(result),
        rideNumber: result.rideNumber,
        reference: result.reference,
        returnRideNumber: result.returnRideNumber,
        returnReference: result.returnReference,
        warnings: result.warnings,
        paid: false,
      });
    }

    // Tussenscherm terwijl de browser naar de betaalpagina gaat.
    function renderRedirectStep() {
      const container = el("div", { class: "wnt-step" });
      container.appendChild(el("h2", { text: "Even geduld…" }));
      container.appendChild(el("p", { text: "U wordt doorgestuurd naar de beveiligde betaalpagina." }));
      return container;
    }

    // Scherm na terugkeer van de betaalpagina (?wnt_order=...): wacht op de
    // bevestiging van de betaling en toont daarna de bevestiging, of een
    // duidelijke uitleg als het niet gelukt is.
    function renderPaymentStep() {
      const p = state.payment;
      const view = p.view;
      const status = view && view.status;
      const container = el("div", { class: "wnt-step" });
      const newBooking = () => {
        window.location.href = currentReturnUrl();
      };
      const phoneHint = "Neem telefonisch contact met ons op als u vragen heeft.";

      if (status === "completed") {
        return renderSummaryView({
          summary: view.summary,
          rideNumber: view.rideNumber,
          reference: view.reference,
          returnRideNumber: view.returnRideNumber,
          returnReference: view.returnReference,
          warnings: view.warnings,
          paid: true,
        });
      }

      if (status === "payment_failed") {
        container.appendChild(el("h2", { text: "Betaling niet gelukt" }));
        container.appendChild(
          el("p", {
            text:
              view.reason === "expired"
                ? "De betaallink is verlopen. Er is niets afgeschreven en er is geen rit geboekt."
                : "De betaling is geannuleerd of niet gelukt. Er is niets afgeschreven en er is geen rit geboekt.",
          })
        );
        container.appendChild(
          el("button", { type: "button", class: "wnt-button wnt-button-primary", text: "Opnieuw boeken", onclick: newBooking })
        );
        return container;
      }

      if (status === "refunded") {
        container.appendChild(el("h2", { text: "Uw betaling is teruggestort" }));
        container.appendChild(
          el("p", {
            text: "Uw betaling is gelukt, maar het gekozen voertuig bleek op dit tijdstip net niet meer beschikbaar. Er is geen rit geboekt en uw bedrag wordt teruggestort; dat kan een paar werkdagen duren.",
          })
        );
        container.appendChild(el("p", { class: "wnt-hint", text: `U kunt een ander tijdstip proberen. ${phoneHint}` }));
        container.appendChild(
          el("button", { type: "button", class: "wnt-button wnt-button-primary", text: "Opnieuw boeken", onclick: newBooking })
        );
        return container;
      }

      if (status === "needs_attention") {
        container.appendChild(el("h2", { text: "Uw betaling is ontvangen" }));
        container.appendChild(
          el("p", {
            text: "Uw betaling is gelukt, maar het vastleggen van uw rit vraagt om een handmatige controle. Wij nemen zo snel mogelijk contact met u op. Wilt u zekerheid, bel ons dan.",
          })
        );
        return container;
      }

      if (status === "unknown") {
        container.appendChild(el("h2", { text: "Boeking niet gevonden" }));
        container.appendChild(
          el("p", { text: `We kunnen deze boeking niet meer vinden (de link is mogelijk te oud). ${phoneHint}` })
        );
        container.appendChild(
          el("button", { type: "button", class: "wnt-button wnt-button-primary", text: "Nieuwe boeking", onclick: newBooking })
        );
        return container;
      }

      // Nog onderweg: nog niet betaald (of de bevestiging moet nog komen), of de rit wordt vastgelegd.
      if (status === "awaiting_payment" && p.cancelled) {
        container.appendChild(el("h2", { text: "Betaling niet voltooid" }));
        container.appendChild(
          el("p", { text: "Er is niets afgeschreven en er is nog geen rit geboekt. U kunt de betaling opnieuw proberen." })
        );
        const row = el("div", { class: "wnt-row" });
        if (view.paymentUrl) {
          row.appendChild(
            el("button", {
              type: "button",
              class: "wnt-button wnt-button-primary",
              text: "Opnieuw betalen",
              onclick: () => {
                window.location.href = view.paymentUrl;
              },
            })
          );
        }
        row.appendChild(el("button", { type: "button", class: "wnt-button wnt-button-secondary", text: "Nieuwe boeking", onclick: newBooking }));
        container.appendChild(row);
        return container;
      }

      container.appendChild(el("h2", { text: status === "processing" ? "Uw rit wordt vastgelegd…" : "Uw betaling wordt gecontroleerd…" }));
      container.appendChild(
        el("p", {
          text:
            status === "processing"
              ? "Uw betaling is ontvangen. We leggen nu uw rit vast; dit duurt een paar seconden. Sluit deze pagina nog niet."
              : "We controleren of uw betaling is gelukt. Dit duurt meestal een paar seconden. Sluit deze pagina nog niet.",
        })
      );
      if (p.error) container.appendChild(el("p", { class: "wnt-hint", text: p.error }));
      if (p.gaveUp) {
        container.appendChild(
          el("p", {
            class: "wnt-error",
            text: `Het duurt langer dan verwacht. Heeft u betaald, dan wordt uw rit nog verwerkt en ontvangt u een bevestiging per e-mail en sms. ${phoneHint}`,
          })
        );
      }
      return container;
    }

    let lastRenderedStep = null;
    const SCROLL_TOP_OFFSET_PX = 90;
    // Terug van de betaalpagina op een lange pagina (bijv. de homepage): de
    // klant landt dan bovenaan de pagina en ziet zijn bevestiging niet. Eenmalig
    // naar het formulier scrollen zodra de status getoond wordt.
    let pendingReturnScroll = false;
    function scrollWidgetIntoView() {
      const top = root.getBoundingClientRect().top;
      window.scrollTo({ top: window.scrollY + top - SCROLL_TOP_OFFSET_PX, behavior: "auto" });
    }

    function render() {
      resetAirportOnlyState();
      root.innerHTML = "";
      const wrapper = el("div", { class: "wnt-widget" });

      if (state.loadError) {
        wrapper.appendChild(el("p", { class: "wnt-error", text: state.loadError }));
        root.appendChild(wrapper);
        return;
      }
      if (state.step === "loading") {
        wrapper.appendChild(el("p", { class: "wnt-hint", text: "Even laden…" }));
        root.appendChild(wrapper);
        return;
      }

      const steps = ["ride", "baggage", "vehicles", "details", "success"];
      const stepLabels = ["Rit", "Bagage", "Voertuig", "Gegevens", "Klaar"];
      // Tijdens het betalen staat de klant in "Gegevens"; pas als de betaling
      // is bevestigd en de rit vastligt, is het "Klaar".
      const activeStep =
        state.step === "payment"
          ? state.payment && state.payment.view && state.payment.view.status === "completed"
            ? "success"
            : "details"
          : state.step === "redirecting"
            ? "details"
            : state.step;
      const progress = el("div", { class: "wnt-progress" });
      steps.forEach((s, i) => {
        progress.appendChild(
          el("span", { class: "wnt-progress-step" + (activeStep === s ? " wnt-progress-step-active" : "") }, [
            `${i + 1}.`,
            el("span", { class: "wnt-progress-label", text: ` ${stepLabels[i]}` }),
          ])
        );
      });
      wrapper.appendChild(progress);

      if (state.step === "ride") wrapper.appendChild(renderRideStep());
      else if (state.step === "baggage") wrapper.appendChild(renderBaggageStep());
      else if (state.step === "vehicles") wrapper.appendChild(renderVehiclesStep());
      else if (state.step === "details") wrapper.appendChild(renderDetailsStep());
      else if (state.step === "success") wrapper.appendChild(renderSuccessStep());
      else if (state.step === "redirecting") wrapper.appendChild(renderRedirectStep());
      else if (state.step === "payment") wrapper.appendChild(renderPaymentStep());

      root.appendChild(wrapper);

      // Nieuwe stap: naar de bovenkant van het formulier scrollen (14 oktober
      // 2026, Hans: bij doorklikken kwam hij niet altijd boven in het volgende
      // scherm). Alleen als de bovenkant van het formulier boven het beeld
      // staat; ruimte erboven voor een vaste kop van de website.
      if (lastRenderedStep !== null && lastRenderedStep !== state.step) {
        const top = root.getBoundingClientRect().top;
        if (top < 0) window.scrollTo({ top: window.scrollY + top - SCROLL_TOP_OFFSET_PX, behavior: "auto" });
      }
      lastRenderedStep = state.step;

      if (pendingReturnScroll && state.step !== "loading") {
        pendingReturnScroll = false;
        scrollWidgetIntoView();
        // De pagina eromheen (afbeeldingen, Elementor) kan na het laden nog
        // verspringen: nogmaals uitlijnen zodra alles geladen is.
        if (document.readyState !== "complete") {
          window.addEventListener("load", () => scrollWidgetIntoView(), { once: true });
        }
      }
    }

    // Terug van de betaalpagina met de browser-terugknop: het formulier
    // staat dan (via de back/forward-cache) nog "Bezig…" -- weer bruikbaar maken.
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && (state.step === "redirecting" || state.submitting)) {
        state.step = "details";
        state.submitting = false;
        render();
      }
    });

    // Terugkeer van de betaalpagina (?wnt_order=...): direct de status tonen,
    // het formulier zelf is dan niet meer nodig.
    const returnOrderId = getReturnOrderId();
    if (returnOrderId) {
      pendingReturnScroll = true;
      startPaymentReturn(returnOrderId);
    } else {
      fetchConfig();
    }
  }

  function init() {
    document.querySelectorAll("[data-wnt-widget]").forEach(createWidget);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
