# Polityka prywatności

Wersja 1, obowiązuje od [data startu].

> In English: we store Reports without any information about who made them. Your IP address is
> never written to our server logs or database. Photos and notes stay on your phone until you send
> a Notice. Opening a map connects your device to OpenStreetMap. The Polish text below is the
> binding one.

## Kto jest administratorem

Administratorem danych jest Alicja Barankiewicz, bor-czuwa@pm.me. Pod ten adres możesz pisać w
każdej sprawie dotyczącej danych. Odpowiadamy w ciągu miesiąca.

## Co przechowujemy o zgłoszeniu

Aplikacja nie ma kont. Nie pytamy o imię, nazwisko, e-mail ani telefon, a zgłoszenie na serwerze
nie ma pola, w którym dałoby się je zapisać.

Na serwer trafia:

- rodzaj zdarzenia i, jeśli go podasz, gatunek zwierzęcia,
- czas zdarzenia, czas zapisania zgłoszenia w telefonie i czas jego odebrania przez serwer,
  zaokrąglony do minuty,
- miejsce zdarzenia, w jednej z trzech postaci: pozycja telefonu w chwili zapisu wraz z jej
  dokładnością, punkt wskazany przez ciebie na mapie albo przybliżony obszar. Obszar wysyłamy, gdy
  oceniasz zdarzenie z daleka, na przykład strzał ze słuchu, i wtedy dołączamy podany kierunek i
  odległość. Przy punkcie z mapy i przy obszarze pozycja telefonu nie trafia na serwer,
- informacja, czy do zgłoszenia dołączono notatkę i zdjęcia, oraz skrót (hash) każdego zdjęcia,
- pomiary, które serwer liczy po synchronizacji: odległości od zabudowań mieszkalnych, obszarów
  chronionych i granic obwodu łowieckiego, pora doby, okres ochronny,
- wersja aplikacji oraz tej polityki i regulaminu serwisu obowiązujących w chwili zgłoszenia,
- przebieg powiadomień: rodzaj i jednostka organu, wersja wzoru, czas przygotowania i przekazania
  powiadomienia, twoje potwierdzenie wysłania oraz, jeśli je zaznaczysz, rodzaj odpowiedzi organu i
  jej data.

Jeśli zgłaszasz zdarzenie z domu zapisanego w aplikacji, serwer dostaje tylko przybliżony obszar,
bez kierunku i odległości. Dokładne położenie domu zostaje w telefonie.

Na serwer nie trafia:

- treść notatki ani same zdjęcia. Zostają w telefonie i idą tylko w powiadomieniu, które
  wysyłasz ze swojej skrzynki,
- twoje dane z powiadomienia podpisanego. Imię, nazwisko i adres zostają w telefonie i idą tylko
  w powiadomieniu, które wysyłasz,
- identyfikator ani model telefonu, język interfejsu, ślad twoich pozycji.

Szkic (zgłoszenie zapisane jednym dotknięciem, żeby dokończyć je później) nigdy nie opuszcza
telefonu.

## Adres IP

Serwer widzi adres IP, kiedy telefon się z nim łączy, ale nigdy go nie zapisuje: ani w logach, ani
w bazie. Żeby utrudnić zasypanie bazy fałszywymi zgłoszeniami, przy każdym zapisie na serwerze
liczymy z adresu skrót z losową solą, którą serwer trzyma tylko w pamięci i losuje od nowa o
północy. Skrót nie jest powiązany z żadnym zgłoszeniem i wygasa o północy, czyli najpóźniej po
25 godzinach. Serwer usuwa wygasłe skróty co minutę, a jeśli akurat nie działał, zaraz po
ponownym uruchomieniu. Logowanie żądań HTTP jest wyłączone, a logi błędów serwera HTTP są
odrzucane.

Pozycję telefonu i skrót adresu traktujemy jako dane osobowe, choć sami nie potrafimy powiązać ich
z żadną osobą.

## Na jakiej podstawie

Art. 6 ust. 1 lit. f RODO: nasz prawnie uzasadniony interes, czyli dokumentowanie zdarzeń
związanych z polowaniami, żeby można było powiadomić o nich właściwe organy i pokazać skalę
problemu. Nie prosimy o zgodę. Podanie danych jest dobrowolne.

## Kto ma dostęp

Serwer wynajmujemy w OVH, które przetwarza dane w naszym imieniu. Serwer stoi w Kanadzie, poza
Europejskim Obszarem Gospodarczym. Kanada ma decyzję Komisji Europejskiej o odpowiednim stopniu
ochrony danych (art. 45 RODO). Dane zgłoszeń przechowujemy tylko na nim. Sami nie robimy kopii
zapasowych. OVH codziennie kopiuje dysk serwera i trzyma tylko najnowszą kopię, sprzed najwyżej
doby. Pocztę projektu obsługuje Proton ze Szwajcarii. Stronę informacyjną utrzymuje
LH.pl, którego serwer zapisuje adresy IP odwiedzających
przez 30 dni. Mapy i wyszukiwanie miejsc korzystają z
usług OpenStreetMap opisanych poniżej.

Organom nie wysyłamy niczego. Powiadomienie wysyłasz ty, ze swojej skrzynki, albo podpisane
składasz jako plik PDF przez ePUAP lub e-Doręczenia. Aplikacja nie loguje się do tych usług i nie
wie, czy powiadomienie dotarło. Tylko w ten sposób zgłoszenie trafia do policji, Państwowej Straży
Łowieckiej czy gminy.

## Mapa i wyszukiwanie miejsc

Mapa jest zamknięta, dopóki nie wybierzesz „Pokaż mapę”. Aplikacja pamięta ten wybór podczas
bieżącego korzystania z niej. Nie otwiera mapy na podstawie zapisanego domu. Po otwarciu
telefon pobiera kafelki mapy bezpośrednio z tile.openstreetmap.org. OpenStreetMap otrzymuje
adres IP telefonu, adres naszej aplikacji i oglądany obszar, także gdy przesuwasz lub
powiększasz mapę.

Wyszukiwanie działa dopiero po naciśnięciu „Szukaj”. Nasz serwer przekazuje wpisaną nazwę
usłudze Nominatim OpenStreetMap. Nie przekazuje adresu IP telefonu, zapisanej pozycji ani
domu. Nominatim widzi adres IP naszego serwera. Nie wpisuj adresu domu. W pamięci serwera przechowujemy do 200 wyszukanych nazw wraz z wynikami. Kolejne
wyszukiwania zastępują najstarsze wpisy, a restart serwera usuwa całość. Nie zapisujemy
wyszukiwanych nazw w logach.

Usługi te prowadzi OpenStreetMap Foundation z siedzibą w Wielkiej Brytanii, poza Europejskim
Obszarem Gospodarczym. Wielka Brytania i Szwajcaria (Proton) mają decyzje Komisji Europejskiej o
odpowiednim stopniu ochrony danych. Podstawą jest nasz uzasadniony interes w pokazaniu mapy i
wyszukaniu miejsca (art. 6 ust. 1 lit. f RODO). Obsługa ich żądań, w tym logi i przetwarzanie
poza EOG, podlega
[polityce prywatności OpenStreetMap Foundation](https://wiki.osmfoundation.org/wiki/Privacy_Policy).
Nasze zasady dotyczące logów nie obejmują serwerów OpenStreetMap.

## Publikacja

Zgłoszenia będą publikowane na publicznej mapie, z przybliżonym miejscem i datą. Nie publikujemy
notatek ani zdjęć, bo nie mamy ich na serwerze. Nie publikujemy pozycji twojego telefonu.

## Jak długo

Zgłoszenia są archiwum i nie mają daty ważności. Poza dobową kopią dysku u OVH nie ma innych kopii.

Zgłoszenie możesz wycofać w aplikacji. Usuwamy wtedy z serwera zgłoszenie, jego pomiary i
przebieg powiadomień. Zostaje losowy numer zgłoszenia, skrót klucza do wycofania i czas
wycofania z dokładnością do minuty, żeby zgłoszenie wysłane z opóźnieniem nie wróciło na serwer.
Z kopii dysku u OVH zgłoszenie znika w ciągu doby, gdy zastąpi ją następna.

## Twoje prawa

Masz prawo dostępu do danych, ich sprostowania, usunięcia i ograniczenia przetwarzania, prawo
sprzeciwu i prawo skargi do Prezesa Urzędu Ochrony Danych Osobowych. Ponieważ nie wiemy, kto
wysłał które zgłoszenie, przy wniosku musisz wskazać zgłoszenie, na przykład po miejscu i czasie.

<h2 id="jesli-zgloszenie-dotyczy-ciebie">Jeśli zgłoszenie dotyczy ciebie</h2>

Zgłoszenie może dotyczyć osoby, która na polowaniu była albo mogła być. Nie wiemy, kim jest, więc
nie możemy powiadomić jej osobiście (art. 14 ust. 5 lit. b RODO). Ta część jest dla niej.

Administratorem jest Alicja Barankiewicz, bor-czuwa@pm.me. Zgłoszenia przetwarzamy na podstawie
art. 6 ust. 1 lit. f RODO, w interesie opisanym wyżej.

Zgłoszenie zawiera miejsce, czas, rodzaj zdarzenia, gatunek i pomiary odległości. Nie zawiera
nazwisk, zdjęć ani opisów. Pomiary opisują miejsce i czas, nie ludzi, i my nie podejmujemy na ich
podstawie decyzji wobec nikogo.

Zgłoszenia pochodzą od anonimowych użytkowników aplikacji. Odbiorcami będą wszyscy oglądający
publiczną mapę, a w naszym imieniu dane przetwarza OVH. Dane zgłoszeń przechowujemy bez terminu na
serwerze w Kanadzie. Korzystanie z mapy i wyszukiwania miejsc opisaliśmy osobno
powyżej.

Jeśli uważasz, że zgłoszenie dotyczy ciebie, napisz na bor-czuwa@pm.me z tematem „sprzeciw /
usunięcie” i wskaż zgłoszenie: numerem z mapy albo miejscem i datą. Na mapie przy każdym zgłoszeniu będzie
też link do takiego wniosku. Odpowiemy w ciągu miesiąca. Uwzględniony wniosek zdejmuje zgłoszenie z mapy.
Zostaje w archiwum i w liczbie zgłoszeń, bez publikacji.

Masz prawo dostępu, sprostowania, usunięcia, ograniczenia przetwarzania, sprzeciwu i skargi do
Prezesa Urzędu Ochrony Danych Osobowych.
