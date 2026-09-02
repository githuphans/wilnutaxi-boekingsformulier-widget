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
 * Wat bewust nog NIET (goed) zit — zie widget/README.md voor de volledige
 * lijst: de geocoding-bevestigingsvraag bij een letterlijk getypt
 * POI-adres uit het startdocument ("Bedoelt u Eindhoven Airport?" — nu
 * alleen exacte naam/adres-matching, geen echte geocoding-vergelijking),
 * de zone-herkenning uit een getypt huisadres (nu een simpele gok, zie
 * `guessZoneFromAddress`), online betalen, en huisstijl-afstemming met de
 * echte Elementor-pagina (nu een neutrale eigen stijl via CSS-variabelen).
 */
(function () {
  "use strict";

  function euro(amount) {
    return new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);
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
      origin: { text: "", poiId: null, confirmed: false },
      destination: { text: "", poiId: null, confirmed: false },
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
      note: "",
      priceResult: null,
      priceError: null,
      selectedVehicleId: null,
      passenger: { firstName: "", lastName: "", email: "", phoneNumber: "" },
      bookResult: null,
      bookError: null,
      submitting: false,
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

    function determineRideMeta() {
      // Richting volgt uit welk veld een herkende POI bevat — geen aparte
      // vraag (zie startdocument, "Gekozen ontwerp: POI-herkenning...").
      if (state.destination.poiId) {
        const poi = findPoiById(state.destination.poiId);
        return {
          direction: "heen",
          poiId: state.destination.poiId,
          fixedRouteZone: guessZoneFromAddress(state.origin.text),
          poi,
        };
      }
      if (state.origin.poiId) {
        const poi = findPoiById(state.origin.poiId);
        return {
          direction: "terug",
          poiId: state.origin.poiId,
          fixedRouteZone: guessZoneFromAddress(state.destination.text),
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

    // Heeft de klant al "Grote ruimbagage" opgegeven, dan weten we al dat er
    // bagage van de band gehaald moet worden -- de losse vraag hieronder is
    // dan overbodig (Hans, 19 augustus 2026). "grote_ruimbagage" is het id
    // uit de meegeleverde configuratie (zie pricingConfig.json/`/admin`);
    // mocht dat id ooit wijzigen, dan valt deze check simpelweg terug op
    // "geen grote ruimbagage bekend" en wordt de vraag weer gewoon gesteld.
    function hasLargeCheckedBaggage() {
      return (state.baggageCounts.grote_ruimbagage || 0) > 0;
    }

    function shouldAskAirportBaggageQuestion() {
      return isAirportPickup() && !hasLargeCheckedBaggage();
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
        }
      } catch (err) {
        state.priceError = "Kon geen verbinding maken met de prijsberekening. Probeer het opnieuw.";
      }

      state.submitting = false;
      render();
    }

    async function submitBooking() {
      state.submitting = true;
      state.bookError = null;
      render();

      const meta = determineRideMeta();
      const noteParts = [];
      if (isAirportPickup()) {
        // Grote ruimbagage opgegeven? Dan staat het antwoord feitelijk al
        // vast, ook als de vraag zelf (bewust) niet gesteld is -- zie
        // shouldAskAirportBaggageQuestion hierboven.
        const effectiveAnswer = hasLargeCheckedBaggage() ? "ruimbagage" : state.airportBaggageAnswer;
        if (effectiveAnswer) {
          noteParts.push(
            effectiveAnswer === "ruimbagage"
              ? "Passagier moet bagage van de bagageband ophalen (langere wachttijd na landing)."
              : "Passagier heeft alleen handbagage bij zich."
          );
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
        passenger: state.passenger,
        note: noteParts.join(" ") || undefined,
      };

      try {
        const response = await fetch(`${apiBase}/api/book`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok) {
          state.bookError = data.details ? `${data.error}: ${JSON.stringify(data.details)}` : data.error || `HTTP ${response.status}`;
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
        field.text = text;
        field.poiId = poiId || null;
        field.confirmed = true;
        suggestions.hidden = true;
        if (onFieldChange) onFieldChange();
        render();
      }

      function renderSuggestionList(query) {
        const pois = state.config.pois || [];
        const poiMatches = query ? pois.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())) : pois;

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
          recognized.textContent = `✓ Herkend als ${poi.name} — vast tarief van toepassing indien beschikbaar.`;
          recognized.hidden = false;
        } else if (field.confirmed) {
          recognized.textContent = "✓ Adres bevestigd.";
          recognized.hidden = false;
        } else {
          recognized.hidden = true;
        }
      }
      updateRecognized();

      const input = el("input", {
        type: "text",
        value: field.text,
        placeholder: "Adres, plaatsnaam of bekende bestemming",
        oninput: (e) => {
          field.text = e.target.value;
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
          }
          refreshSuggestions(field.text);
          updateRecognized();
          if (onFieldChange) onFieldChange();
        },
        onfocus: () => refreshSuggestions(field.text),
        onblur: () => setTimeout(() => (suggestions.hidden = true), 150),
      });

      wrapper.appendChild(input);
      wrapper.appendChild(suggestions);
      wrapper.appendChild(recognized);

      return wrapper;
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

      container.appendChild(renderAddressField("Ophaaladres", "origin", updateServiceAreaWarning));
      container.appendChild(renderAddressField("Bestemming", "destination", updateServiceAreaWarning));
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
              state.dateTimeTouched = true;
            }
            render();
          },
        })
      );
      dateWrapper.appendChild(
        el("p", { class: "wnt-hint" }, [
          "Gekozen moment: ",
          // Dag+datum/tijd extra opvallend (vet en groter) gemaakt, zodat
          // het meteen opvalt als het formulier de datum automatisch heeft
          // doorgezet (Hans, 20 augustus 2026: "zou daar de dag en de datum
          // vet en groter kunnen worden weergegeven zodat het beter
          // opvalt").
          el("strong", { class: "wnt-chosen-moment", text: formatDateTime(getEffectiveDateTime()) }),
          ". We gaan standaard uit van minimaal 24 uur van tevoren boeken voor de scherpste prijs — pas gerust aan als u eerder wilt vertrekken.",
        ])
      );
      container.appendChild(dateWrapper);

      const passengersRow = el("div", { class: "wnt-row" });
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
      [
        { value: true, label: "Ja" },
        { value: false, label: "Nee" },
      ].forEach((opt) => {
        const radioId = `wnt-has-baggage-${opt.value}`;
        baggageQuestionWrapper.appendChild(
          el("label", { class: "wnt-radio-label", for: radioId }, [
            el("input", {
              type: "radio",
              id: radioId,
              name: "wnt-has-baggage",
              checked: state.hasBaggage === opt.value ? "" : undefined,
              onchange: () => {
                state.hasBaggage = opt.value;
                // Wél opnieuw renderen (in tegenstelling tot bij het typen
                // in een tekstveld): dit is een discrete klik, geen
                // doorlopende invoer, en de knoptekst hieronder ("Verder
                // naar bagage" vs. "Bekijk prijzen") hangt hiervan af.
                render();
              },
            }),
            " " + opt.label,
          ])
        );
      });
      container.appendChild(baggageQuestionWrapper);

      container.appendChild(
        el("button", {
          type: "button",
          class: "wnt-button wnt-button-primary",
          text: state.hasBaggage === false ? (state.submitting ? "Bezig…" : "Bekijk prijzen") : "Verder naar bagage",
          disabled: state.submitting ? "" : undefined,
          onclick: () => {
            if (!state.origin.text.trim() || !state.destination.text.trim()) {
              alert("Vul zowel het ophaaladres als de bestemming in.");
              return;
            }
            // Zie isFieldConfirmed hierboven: een adres moet uit de
            // voorgestelde lijst gekozen zijn (of exact overeenkomen), zodat
            // we zeker weten dat het een geldig, door Google herkend adres
            // is — met een uitleg wat de klant moet doen, in plaats van een
            // te summiere foutmelding (feedback Hans, 18 augustus 2026).
            if (!isFieldConfirmed(state.origin)) {
              alert(
                `We kunnen "${state.origin.text}" niet herkennen als geldig adres. Begin opnieuw te typen in het ophaaladres-veld en kies één van de voorgestelde adressen uit de lijst die verschijnt.`
              );
              return;
            }
            if (!isFieldConfirmed(state.destination)) {
              alert(
                `We kunnen "${state.destination.text}" niet herkennen als geldige bestemming. Begin opnieuw te typen in het bestemmingsveld en kies één van de voorgestelde adressen uit de lijst die verschijnt.`
              );
              return;
            }
            if (state.hasBaggage === false) {
              // Geen bagage-stap nodig: baggageCounts/specialBaggageId staan
              // al op hun neutrale standaardwaarde. Bij een luchthavenrit is
              // "geen bagage" ook meteen het antwoord op de
              // bagageband-vraag (zie renderBaggageStep) -- die stap wordt
              // hier overgeslagen, dus die vullen we hier vast zelf in, in
              // plaats van de chauffeur zonder enig antwoord te laten.
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

    function renderStepperField(labelText, value, min, max, onChange) {
      const wrapper = el("div", { class: "wnt-field wnt-stepper" });
      wrapper.appendChild(el("label", { text: labelText }));
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
      container.appendChild(
        el("p", { class: "wnt-hint" }, [
          "Zo weten we zeker dat we met een voertuig komen waar alle bagage in past.",
        ])
      );

      (state.config.baggageTypes || []).forEach((type) => {
        container.appendChild(
          renderStepperField(type.name, state.baggageCounts[type.id] || 0, 0, 10, (v) => {
            state.baggageCounts[type.id] = v;
          })
        );
      });

      const specialWrapper = el("div", { class: "wnt-field" });
      specialWrapper.appendChild(el("label", { text: "Bijzondere bagage" }));
      const select = el("select", {
        onchange: (e) => {
          state.specialBaggageId = e.target.value;
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
              },
            }),
            " " + opt.label,
          ]);
          airportWrapper.appendChild(label);
        });
        airportWrapper.appendChild(
          el("p", { class: "wnt-hint" }, ["Zo kunnen we beter inschatten hoe laat u daadwerkelijk buiten staat."])
        );
        container.appendChild(airportWrapper);
      }

      if (state.priceError) {
        container.appendChild(el("p", { class: "wnt-error" }, [String(state.priceError)]));
      }

      const buttonRow = el("div", { class: "wnt-row" });
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
          onclick: fetchPrice,
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

    function renderVehiclesStep() {
      const container = el("div", { class: "wnt-step" });
      container.appendChild(el("h2", { text: "Kies uw voertuig" }));

      if (state.priceResult && state.priceResult.route) {
        container.appendChild(
          el("p", { class: "wnt-hint" }, [
            `Afstand: ${state.priceResult.route.distanceKm.toFixed(1)} km, rijtijd: ${Math.round(
              state.priceResult.route.durationMinutes
            )} min.`,
          ])
        );
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

      const grid = el("div", { class: "wnt-vehicle-grid" });
      (state.priceResult ? state.priceResult.vehicles : []).forEach((vehicle) => {
        const isSelected = state.selectedVehicleId === vehicle.vehicleId;
        const card = el("div", {
          class: "wnt-vehicle-card" + (vehicle.available ? "" : " wnt-vehicle-unavailable") + (isSelected ? " wnt-vehicle-selected" : ""),
        });
        card.appendChild(renderVehicleImage(vehicle));
        card.appendChild(el("h3", { text: vehicle.name }));
        card.appendChild(el("p", { class: "wnt-vehicle-model", text: vehicle.model }));
        if (vehicle.price) {
          card.appendChild(el("p", { class: "wnt-vehicle-price", text: euro(vehicle.price.totalEuro) }));
        }
        if (!vehicle.available) {
          card.appendChild(
            el("p", { class: "wnt-vehicle-reason" }, [
              !vehicle.baggage.fits
                ? vehicle.baggage.reason || "Bagage past niet in dit voertuig."
                : vehicle.priceError || "Prijs kon niet berekend worden.",
            ])
          );
        }
        if (vehicle.price && vehicle.price.warnings && vehicle.price.warnings.length) {
          vehicle.price.warnings.forEach((w) => card.appendChild(el("p", { class: "wnt-vehicle-warning", text: w })));
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

      function textField(labelText, key, type) {
        const wrapper = el("div", { class: "wnt-field" });
        wrapper.appendChild(el("label", { text: labelText }));
        wrapper.appendChild(
          el("input", {
            type: type || "text",
            value: state.passenger[key],
            required: "",
            oninput: (e) => {
              state.passenger[key] = e.target.value;
            },
          })
        );
        return wrapper;
      }

      container.appendChild(textField("Voornaam", "firstName"));
      container.appendChild(textField("Achternaam", "lastName"));
      container.appendChild(textField("E-mailadres", "email", "email"));
      container.appendChild(textField("Telefoonnummer", "phoneNumber", "tel"));

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

      const buttonRow = el("div", { class: "wnt-row" });
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
          text: state.submitting ? "Bezig…" : "Bevestig boeking",
          disabled: state.submitting ? "" : undefined,
          onclick: () => {
            const p = state.passenger;
            if (!p.firstName || !p.lastName || !p.email || !p.phoneNumber) {
              alert("Vul alle gegevens in.");
              return;
            }
            submitBooking();
          },
        })
      );
      container.appendChild(buttonRow);

      return container;
    }

    function renderSuccessStep() {
      const container = el("div", { class: "wnt-step" });
      container.appendChild(el("h2", { text: "Boeking bevestigd" }));
      const result = state.bookResult;
      container.appendChild(el("p", { text: `Bedankt! Uw rit is geboekt voor ${euro(result.price.totalEuro)}.` }));
      if (result.trackAndTraceLink) {
        container.appendChild(
          el("p", {}, [
            "Track & trace: ",
            el("a", { href: result.trackAndTraceLink, target: "_blank", rel: "noopener", text: result.trackAndTraceLink }),
          ])
        );
      }
      if (result.warnings && result.warnings.length) {
        result.warnings.forEach((w) => container.appendChild(el("p", { class: "wnt-hint", text: w })));
      }
      return container;
    }

    function render() {
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
      const progress = el("div", { class: "wnt-progress" });
      steps.forEach((s, i) => {
        progress.appendChild(
          el("span", { class: "wnt-progress-step" + (state.step === s ? " wnt-progress-step-active" : "") }, [
            `${i + 1}. ${stepLabels[i]}`,
          ])
        );
      });
      wrapper.appendChild(progress);

      if (state.step === "ride") wrapper.appendChild(renderRideStep());
      else if (state.step === "baggage") wrapper.appendChild(renderBaggageStep());
      else if (state.step === "vehicles") wrapper.appendChild(renderVehiclesStep());
      else if (state.step === "details") wrapper.appendChild(renderDetailsStep());
      else if (state.step === "success") wrapper.appendChild(renderSuccessStep());

      root.appendChild(wrapper);
    }

    fetchConfig();
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
