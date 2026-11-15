export type Lang = 'pl' | 'en';
export type PageKey = 'home' | 'privacy' | 'terms' | 'about' | 'support';

export const paths: Record<PageKey, Record<Lang, string>> = {
  home: { pl: '/', en: '/en/' },
  privacy: { pl: '/prywatnosc/', en: '/en/privacy/' },
  terms: { pl: '/regulamin/', en: '/en/terms/' },
  about: { pl: '/o-projekcie/', en: '/en/about/' },
  support: { pl: '/wesprzyj/', en: '/en/support/' }
};

// The Polish is the text the owner approved; change it only with her. The English is translated
// from it and has to keep the same keys (tests/copy-keys.test.ts).
const pl = {
  name: 'Bór czuwa',
  skip: 'Przejdź do treści',
  nav: { about: 'O projekcie', privacy: 'Prywatność', terms: 'Regulamin', support: 'Wesprzyj' },
  otherLanguage: 'English',
  // The header's light and dark switch (owner, 2026-11-12).
  theme: 'Ciemny motyw',
  footer: {
    line: 'Niezależny projekt.',
    portfolio: 'Portfolio',
    // The source repository, shown as on engender: GitHub's mark and this word.
    github: 'github',
    copyright: '2026 Alicja Barankiewicz'
  },
  home: {
    title: 'Bór czuwa: zgłoś nielegalne polowanie',
    description: 'Aplikacja pomaga zgłosić zdarzenie przy polowaniu policji i innym urzędom, a potem zapisuje, czy odpowiedziały. Tak powstają liczby: ile zdarzeń, gdzie i jakich. Bez konta.',
    headline: 'Strzały za domem? Bór czuwa.',
    // The owner's line, word for word (2026-11-12, ticket 16).
    hook: 'Wszyscy wiedzą, że Policja ignoruje takie zgłoszenia - Bór czuwa pozwala to udowodnić.',
    lead: 'Wskaż miejsce i czas, a Bór czuwa zmierzy odległość od domów i przygotuje zgłoszenie do służb.',
    store: {
      play: 'Pobierz z Google Play',
      openApp: 'Otwórz w przeglądarce',
      iphone: 'Na iPhonie działa w przeglądarce.',
      help: 'Zapisanie zgłoszenia nie sprowadza pomocy. W nagłym zagrożeniu dzwoń pod 112.'
    },
    // The premise (ticket 16). The first sentence is the owner's, word for word; then what people
    // witness, and the two things the app does about it.
    why: {
      heading: 'Po co czuwać',
      body: [
        'Aplikacja Bór czuwa jest próbą odpowiedzi na poczucie bezradności związane z nagminnymi naruszeniami i wykroczeniami w trakcie polowań w Polsce. Poluje się na gatunki chronione i w miejscach, gdzie nie wolno: w parkach narodowych, w rezerwatach, bliżej niż 150 m od zabudowań mieszkalnych. Przy leśnych szlakach zostają szczątki zwierząt, zanęty i pułapki.',
        'Bór czuwa robi z tym dwie rzeczy. Pomaga zgłosić zdarzenie właściwym urzędom i zapisuje je anonimowo. Sześć tygodni po wysłaniu podpisanego powiadomienia pyta, czy urząd odpowiedział. Z tych zapisów powstają liczby: ile jest takich zdarzeń, gdzie, jakiego rodzaju i czy policja i inne urzędy się nimi zajmują.'
      ]
    },
    how: {
      heading: 'Jak to działa',
      steps: [
        { title: 'Zapisz zdarzenie', body: 'Wskazujesz typ zdarzenia, miejsce i czas. Resztę dopiszesz później.' },
        {
          title: 'Zobacz pomiary',
          body: 'Aplikacja sprawdza miejsce według ustawy Prawo łowieckie i granic obszarów chronionych, na przykład mierzy odległość od zabudowań mieszkalnych. Pomiary nie rozstrzygają o winie.'
        },
        {
          title: 'Wyślij powiadomienie',
          body: 'Aplikacja przygotowuje powiadomienia do właściwych urzędów, z treścią i adresem dla miejsca zdarzenia. Wysyłasz je ze swojej poczty, z podpisem albo bez (bez podpisu urząd widzi tylko adres e-mail). Podpisane możesz też złożyć jako PDF przez ePUAP lub e-Doręczenia.'
        },
        {
          title: 'Zapisz odpowiedź urzędu',
          body: 'Przy każdym powiadomieniu zaznaczasz, co zrobił urząd: odpowiedział, wszczął postępowanie, odmówił albo jeszcze milczy. Urząd tych odpowiedzi nie potwierdza.'
        }
      ]
    },
    features: {
      heading: 'Najważniejsze',
      items: [
        { title: 'Bez konta', body: 'Nie zakładasz konta, a imię i nazwisko do podpisu zostają na telefonie.' },
        {
          title: 'Cicho i bez zasięgu',
          body: 'Telefon nie błyska, nie wydaje dźwięku i nie wibruje, a zapis działa bez internetu.'
        },
        {
          title: 'Przybliżone miejsce',
          body: 'Przy strzale i przy zgłoszeniu z domu serwer dostaje tylko przybliżony obszar.'
        },
        {
          title: 'Właściwy urząd',
          body: 'Aplikacja podpowiada policję, Państwową Straż Łowiecką i gminę dla danego miejsca, a w parku narodowym lub rezerwacie także park albo RDOŚ.'
        },
        {
          title: 'Wycofanie',
          body: 'Zgłoszenie wycofasz z telefonu, na którym powstało, i zniknie także z serwera.'
        },
        {
          title: 'Pomiary z dokładnością',
          body: 'Każdy pomiar podaje swoją dokładność i datę przepisów, według których go policzono.'
        },
        {
          title: 'Po polsku i po angielsku',
          body: 'Aplikacja działa po polsku i po angielsku, a powiadomienie zawsze pisze po polsku.'
        },
        {
          title: 'Wolne oprogramowanie',
          body: 'Kod jest otwarty na licencji GPLv3, więc każdy może sprawdzić, co aplikacja robi z danymi.'
        }
      ]
    }
  },
  about: {
    title: 'O projekcie · Bór czuwa',
    description: 'Po co powstał Bór czuwa, kto go prowadzi i jak się skontaktować. Znak do pobrania i kod źródłowy.',
    heading: 'O projekcie',
    purpose: [
      'Bór czuwa pomaga zgłaszać zdarzenia przy polowaniach i prowadzi ich rejestr: ile ich jest, gdzie, jakiego rodzaju i czy urzędy na nie odpowiadają.',
      'Liczby pochodzą ze zgłoszeń i z odpowiedzi zapisanych przez osoby zgłaszające. Urzędy ich nie potwierdzają.'
    ],
    intro: [
      'To niezależny projekt. Prowadzi go Alicja Barankiewicz, administratorka danych.',
      'Aplikacja nie jest usługą urzędową i nie reprezentuje policji ani innych organów.'
    ],
    contact: { heading: 'Kontakt' },
    mark: { heading: 'Znak', svg: 'Pobierz SVG', png: 'Pobierz PNG' },
    source: { heading: 'Kod źródłowy', licence: 'Wolne oprogramowanie na licencji GPLv3.' }
  },
  // The support page (owner, 2026-11-12): donations through Buy Me a Coffee, and supporting
  // organisations listed with their logo once she has approved each one (supporters.ts).
  support: {
    title: 'Wesprzyj · Bór czuwa',
    description: 'Jak wesprzeć Bór czuwa i które organizacje już go wspierają.',
    heading: 'Wesprzyj projekt',
    intro: [
      'Bór czuwa jest bezpłatny, bez reklam i bez konta. Wpłaty pomagają opłacić serwer i dalszą pracę.',
      'Organizacja, która wesprze projekt, może trafić ze swoim logo na listę poniżej. Każde logo pojawia się po sprawdzeniu.'
    ],
    donate: 'Wesprzyj przez Buy Me a Coffee',
    logo: 'Po wpłacie napisz na adres {email}, podaj nazwę organizacji i dołącz logo.',
    listHeading: 'Organizacje wspierające',
    empty: 'Na liście nie ma jeszcze żadnej organizacji.'
  },
  privacy: {
    title: 'Polityka prywatności · Bór czuwa',
    description: 'Jakie dane zbiera Bór czuwa, gdzie je przechowuje i jak wycofać zgłoszenie.'
  },
  terms: { title: 'Regulamin · Bór czuwa', description: 'Zasady korzystania z aplikacji Bór czuwa.' }
};

const en: typeof pl = {
  name: 'Bór czuwa',
  skip: 'Skip to content',
  nav: { about: 'About', privacy: 'Privacy', terms: 'Terms', support: 'Support' },
  otherLanguage: 'Polski',
  theme: 'Dark theme',
  footer: {
    line: 'An independent project.',
    portfolio: 'Portfolio',
    // The source repository, shown as on engender: GitHub's mark and this word.
    github: 'github',
    copyright: '2026 Alicja Barankiewicz'
  },
  home: {
    title: 'Bór czuwa: report a hunting incident',
    description: 'Helps you report a hunting incident to the police and other authorities, then records whether they replied. That gives numbers: how many incidents, where, what kind. No account.',
    headline: 'Shots behind your house? Bór czuwa.',
    hook: 'Everyone knows the police ignore these reports. Bór czuwa lets you prove it.',
    lead: 'Give the place and time; Bór czuwa measures distance to homes and drafts the report to the authorities.',
    store: {
      play: 'Get it on Google Play',
      openApp: 'Open in browser',
      iphone: 'On iPhone, use the browser.',
      help: 'Saving a report does not bring help. In an emergency, call 112.'
    },
    why: {
      heading: 'Why keep watch',
      body: [
        'Bór czuwa is an attempt to answer the helplessness felt at constant violations and offences during hunts in Poland. People hunt protected species, and where hunting is banned: in national parks, nature reserves, closer than 150 m to homes. Animal remains, bait and traps are left by forest trails.',
        'Bór czuwa does two things about it. It helps you report the incident to the right authorities and stores it anonymously. Six weeks after you send a signed notice, it asks whether the authority replied. Those records add up to numbers: how many incidents, where, what kind, and whether the police and other authorities act on them.'
      ]
    },
    how: {
      heading: 'How it works',
      steps: [
        { title: 'Record the incident', body: 'Give the event type, place and time. Add the rest later.' },
        {
          title: 'See the measurements',
          body: 'The app checks the place against the hunting law (Prawo łowieckie) and protected-area boundaries, for example the distance to zabudowania mieszkalne (homes). Measurements do not rule on guilt.'
        },
        {
          title: 'Send the notice',
          body: 'The app prepares notices for the right authorities, with the text and address for the place. You send them from your own email, signed or unsigned (unsigned, the authority sees only your email address). A signed one can also go as a PDF via ePUAP or e-Doręczenia.'
        },
        {
          title: 'Record the answer',
          body: 'For each notice you mark what the authority did: replied, opened proceedings, refused, or nothing yet. The authority does not confirm these answers.'
        }
      ]
    },
    features: {
      heading: 'Essentials',
      items: [
        { title: 'No account', body: 'No sign-up, and the name you sign with stays on your phone.' },
        {
          title: 'Quiet and offline',
          body: 'The phone makes no flash, sound or vibration, and saving works offline.'
        },
        {
          title: 'Approximate place',
          body: 'For shots and reports from home, the server gets only an approximate area.'
        },
        {
          title: 'Right authority',
          body: 'The app suggests the local police, Państwowa Straż Łowiecka and gmina, plus the park or RDOŚ in a park narodowy or rezerwat.'
        },
        {
          title: 'Withdrawal',
          body: 'A report withdrawn on the phone that made it leaves the server too.'
        },
        {
          title: 'Measured with accuracy',
          body: 'Every measurement states its accuracy and the date of the rules behind it.'
        },
        {
          title: 'Polish and English',
          body: 'The app works in Polish and English; the notice is always in Polish.'
        },
        {
          title: 'Free software',
          body: 'The code is open under GPLv3, so anyone can check what the app does with data.'
        }
      ]
    }
  },
  about: {
    title: 'About · Bór czuwa',
    description: 'Why Bór czuwa exists, who runs it and how to get in touch. The logo and source code.',
    heading: 'About the project',
    purpose: [
      'Bór czuwa helps people report hunting incidents and keeps a record of them: how many, where, what kind, and whether authorities reply.',
      'The numbers come from reports and from the answers reporters record. Authorities do not confirm them.'
    ],
    intro: [
      'An independent project run by Alicja Barankiewicz, the data controller.',
      'The app is not an official service and does not represent the police or other authorities.'
    ],
    contact: { heading: 'Contact' },
    mark: { heading: 'Logo', svg: 'Download SVG', png: 'Download PNG' },
    source: { heading: 'Source code', licence: 'Free software under GPLv3.' }
  },
  support: {
    title: 'Support · Bór czuwa',
    description: 'How to support Bór czuwa and which organisations already do.',
    heading: 'Support the project',
    intro: [
      'Bór czuwa is free, with no ads and no account. Donations help pay for the server and further work.',
      'An organisation that supports the project can go on the list below with its logo. Each logo goes up after a check.'
    ],
    donate: 'Support on Buy Me a Coffee',
    logo: 'After donating, write to {email} with the organisation\'s name and its logo.',
    listHeading: 'Supporting organisations',
    empty: 'No organisations on the list yet.'
  },
  privacy: {
    title: 'Privacy policy · Bór czuwa',
    description: 'What Bór czuwa collects, where it is kept, how to withdraw a report.'
  },
  terms: { title: 'Terms · Bór czuwa', description: 'Terms of use for Bór czuwa.' }
};

export const copy = { pl, en };
