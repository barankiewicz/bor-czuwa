// Provisional Polish copy. Human step 01 replaces this version with reviewed fragments.
export const noticeFragments = {
  version: 'placeholder-2026-09-25',
  effective_from: '2026-09-25',
  skeletons: {
    police: { signed: { id: 'A1', subject: 'Zawiadomienie o podejrzeniu popełnienia przestępstwa łowieckiego', opening: 'Zawiadamiam o zdarzeniu, które może wymagać czynności Policji.', closing: 'Proszę o informację o sposobie załatwienia sprawy.' },
      unsigned: { id: 'A2', subject: 'Informacja o zdarzeniu łowieckim', opening: 'Przekazuję informację o zdarzeniu, które może wymagać sprawdzenia przez Policję.', closing: 'Proszę o sprawdzenie opisanych okoliczności.' } },
    psl: { signed: { id: 'A3', subject: 'Zawiadomienie o zdarzeniu łowieckim', opening: 'Zawiadamiam Państwową Straż Łowiecką o zdarzeniu.', closing: 'Proszę o sprawdzenie opisanych okoliczności i informację o podjętych czynnościach.' },
      unsigned: { id: 'A4', subject: 'Informacja o zdarzeniu łowieckim', opening: 'Przekazuję Państwowej Straży Łowieckiej informację o zdarzeniu.', closing: 'Proszę o sprawdzenie opisanych okoliczności.' } },
    nationalPark: { signed: { id: 'A5', subject: 'Zawiadomienie o zdarzeniu na terenie parku narodowego', opening: 'Zawiadamiam dyrekcję parku narodowego o zdarzeniu.', closing: 'Proszę o sprawdzenie opisanych okoliczności i informację o podjętych czynnościach.' },
      unsigned: { id: 'A6', subject: 'Informacja o zdarzeniu na terenie parku narodowego', opening: 'Przekazuję dyrekcji parku narodowego informację o zdarzeniu.', closing: 'Proszę o sprawdzenie opisanych okoliczności.' } },
    rdos: { signed: { id: 'A7', subject: 'Zawiadomienie o zdarzeniu w rezerwacie przyrody', opening: 'Zawiadamiam regionalną dyrekcję ochrony środowiska o zdarzeniu.', closing: 'Proszę o sprawdzenie opisanych okoliczności i informację o podjętych czynnościach.' },
      unsigned: { id: 'A8', subject: 'Informacja o zdarzeniu w rezerwacie przyrody', opening: 'Przekazuję regionalnej dyrekcji ochrony środowiska informację o zdarzeniu.', closing: 'Proszę o sprawdzenie opisanych okoliczności.' } },
    gmina: { signed: { id: 'A9', subject: 'Informacja o zdarzeniu łowieckim dla gminy', opening: 'Przekazuję informacyjnie wiadomość o zdarzeniu na terenie gminy.', closing: 'Proszę o przyjęcie tej informacji.' },
      unsigned: { id: 'A10', subject: 'Informacja o zdarzeniu łowieckim dla gminy', opening: 'Przekazuję informacyjnie wiadomość o zdarzeniu na terenie gminy.', closing: 'Proszę o przyjęcie tej informacji.' } }
  },
  events: {
    shot: { id: 'B1', text: 'Słyszałam lub słyszałem strzał; nie widziałam ani nie widziałem jego źródła.' },
    person_with_gun: { id: 'B2', text: 'Widziałam lub widziałem osobę z bronią.' },
    remains: { id: 'B3', text: 'Znalazłam lub znalazłem szczątki zwierzęcia.' },
    injured_animal: { id: 'B4', text: 'Widziałam lub widziałem ranne zwierzę.' },
    poaching: { id: 'B5', text: 'Zaobserwowałam lub zaobserwowałem okoliczności mogące wskazywać na kłusownictwo.' }
  }
};
