# Bór czuwa

[English](README.en.md)

Myśliwi w Polsce w dużej mierze pilnują się sami, więc ta aplikacja pozwala każdemu, kto usłyszy
strzał przy domu albo znajdzie postrzelone zwierzę, zgłosić to policji, gminie i Straży Łowieckiej,
a każde zgłoszenie zostaje policzone.

Domena zostanie wybrana przed pierwszym publicznym wydaniem.

## Co robi aplikacja

Zapisujesz, co się stało: strzał, człowiek z bronią, szczątki w lesie, ranne zwierzę albo
kłusownictwo. Telefon zapisuje miejsce i czas razem z dokładnością pomiaru. Nie potrzebujesz do tego
zasięgu. W lesie zwykle go nie ma i aplikacja traktuje to jako normalny stan.

Kiedy zgłoszenie dotrze na serwer, serwer mierzy miejsce według przepisów: odległość do najbliższych
zabudowań mieszkalnych, granice parku narodowego i rezerwatu, obwód łowiecki, porę nocy i okres
ochronny, jeśli podasz gatunek. Z tego i z twojego opisu aplikacja składa powiadomienie do policji,
Państwowej Straży Łowieckiej i gminy, a gdy miejsce leży w parku narodowym albo rezerwacie, także do
parku albo RDOŚ. Powiadomienie wskazuje przepisy, których dotyczą pomiary. Wysyłasz je ze swojej
skrzynki pocztowej. Aplikacja nie wie, czy powiadomienie dotarło, i nigdy nie napisze, że zostało
wysłane.

Każde zgłoszenie jest liczone, także wtedy, gdy nie wyślesz żadnego powiadomienia.

## Dla kogo

Przede wszystkim dla kogoś, kto o świcie słyszy strzały za domem. Taka osoba jest u siebie, zna
okolicę, może być przestraszona albo wściekła i nie musi znać prawa łowieckiego.

Także dla grzybiarzy, ludzi z psem i biegaczy, którzy trafiają na polowanie w lesie, często bez
zasięgu i z jedną wolną ręką. I dla osób, które obserwują polowania zbiorowe celowo i składają wiele
zgłoszeń. One znają przepisy lepiej niż aplikacja i chcą szybkości, nie objaśnień.

## Dlaczego

Dziś nie ma jednego miejsca, w którym można zgłosić polowanie łamiące przepisy. Państwowa Straż
Łowiecka działa osobno w każdym województwie i nie przyjmuje zgłoszeń przez żaden wspólny formularz.
Trzeba znaleźć adres na stronie właściwego urzędu wojewódzkiego. Krajowa Mapa Zagrożeń
Bezpieczeństwa przyjmuje zgłoszenia kłusownictwa, ale żadnych innych naruszeń przy polowaniu. Polski
Związek Łowiecki nie ma publicznego kanału zgłoszeń, a jego postępowania dyscyplinarne toczą się we
własnym gronie. Żadna polska organizacja pozarządowa nie prowadzi narzędzia do takich zgłoszeń.

Ten projekt jest otwarcie przeciwny myślistwu i układowi, w którym myśliwi w dużej mierze sami
pilnują swoich. Chce, żeby te zdarzenia trafiały do organów, które mają obowiązek się nimi zająć, i
żeby dało się je policzyć.

## Czego aplikacja nie robi

Nie orzeka o winie. Ocena podaje pomiary z dokładnością i przepis, którego te pomiary dotyczą.
Rozstrzyga organ, do którego trafia powiadomienie. Zakaz polowania aplikacja stwierdza tylko w dwóch
przypadkach: w parku narodowym i w rezerwacie, który nie ma ani planu ochrony, ani zadań ochronnych.
W obu tylko wtedy, gdy odległość od granicy jest większa niż dokładność pomiaru.

Nie wie, kim jesteś. Nie ma kont ani pola na tożsamość, a imię i nazwisko nigdy nie trafiają na
serwer. Jeśli chcesz podpisać powiadomienie, podpis dopisuje się na telefonie. Adresat zobaczy
adres, z którego powiadomienie wyszło. Powiadomienie bez podpisu nie zobowiązuje organu do wszczęcia
postępowania, a ty nie dowiesz się o jego wyniku. Aplikacja mówi to w chwili, gdy wybierasz.

Nie jest kanałem alarmowym. Zgłoszenie nie sprowadza pomocy.

Nie jest narzędziem kampanii. Nie ma w niej petycji, wezwań do działania ani przycisków do
udostępniania.

## Bezpieczeństwo

Zgłoszenie o strzale albo o człowieku z bronią robisz w pobliżu kogoś, kto trzyma broń. Dlatego nic
w aplikacji nie prosi, żeby podejść, iść za kimś, zostać na miejscu, czekać na lepszy sygnał GPS
albo fotografować człowieka. Aplikacja zapisuje dokładność taką, jaką telefon poda najpierw, nawet
jeśli jest słaba.

Możesz najpierw odejść. Jedno dotknięcie zapisuje szkic: miejsce i dokładny czas. Resztę uzupełnisz
później, w bezpiecznym miejscu albo w domu. Szkic zostaje na telefonie i nie wygasa.

Telefon zachowuje się cicho: bez lampy błyskowej, dźwięku i wibracji. W nocy ekran zgłoszenia jest
ciemny.

O konfrontacji aplikacja mówi jedno zdanie: „Nie podchodź i nie przeszkadzaj w polowaniu: to
niebezpieczne, a utrudnianie polowania jest przestępstwem.”

## Co przechowujemy

Zgłoszenia są przechowywane centralnie. Dokładny punkt zostaje na telefonie, jeśli zgłaszasz
strzał albo robisz zgłoszenie z domu; serwer dostaje wtedy potwierdzony przybliżony obszar.
Pozostałe zgłoszenia zachowują pełną dokładność współrzędnych. Wyniki pomiarów zapisujemy jako
liczby, a nie jako „tak” albo „nie”. Zdjęcia i notatka zostają na twoim telefonie. Serwer dostaje
tylko skrót każdego zdjęcia i informację, że notatka istnieje. Adres IP nie jest zapisywany na
dysku.

Przepisy są zapisane jako datowane zestawy reguł i każda ocena podaje, według którego zestawu
powstała. Zmiana prawa, na przykład odległości od zabudowań, nie unieważnia starszych zgłoszeń.

Serwer działa na VPS w Kanadzie. Wdrożenie produkcyjne wymaga jeszcze
weryfikacji. Administratorką danych jest Alicja Barankiewicz. Polityka prywatności i regulamin serwisu
czekają na przegląd prawny przed publicznym wydaniem.

## Uwaga! Polowanie

Niezależny projekt. Merytorycznie wspiera go Komitet Inicjatywy Uwaga! Polowanie.

Komitet pomaga prawnie i przygotowuje treść powiadomień do organów. Projekt wspiera komitet i jego
inicjatywę ustawodawczą, ale nie jest jego produktem i nie wypowiada się w jego imieniu.

## Przyszła mapa publiczna

Dane są zbierane centralnie z myślą o przyszłej publicznej mapie zgłoszeń i zestawieniach w
czasie. Mapa pokaże wszystkie zgłoszenia bez zdjęć i notatek. Każde zgłoszenie będzie można usunąć z
mapy na wniosek wysłany mailem, ale usunięcie nie zmniejsza liczby zgłoszeń w zestawieniach.
Wykluczenie zgłoszenia zmyślonego, zdublowanego albo testowego zmniejsza tę liczbę, jest publiczne,
ma podany powód i można je cofnąć. Osobną operacją jest wycofanie własnego zgłoszenia z telefonu,
na którym powstało: usuwa zgłoszenie i zmniejsza liczbę.

Starsze dokumenty nazywają mapę „fazą 2”. Obecna faza 2 obejmuje poprawki po audycie aplikacji.
Mapa pozostaje osobnym przyszłym zadaniem, wymagającym specyfikacji i oceny skutków dla ochrony
danych przed publikacją.

## Stan projektu

Aplikacja webowa, wersja na Androida i serwer są zaimplementowane, a kod jest w repozytorium.
Stos to TypeScript, SvelteKit, Capacitor i PostgreSQL/PostGIS. iOS nie jest planowany.
Faza 1 została zamknięta 26 września 2026 r.; niedokończone prace przeszły do kolejnych zadań.
Lokalna wersja działa na danych testowych i nie jest gotowym wydaniem publicznym.

[Faza 6](.scratch/faza-6/issues/README.md) jest zamknięta. Faza 7 to końcowy audyt i poprawki.
Przed wydaniem trzeba zamknąć [sprawy prawne i organizacyjne](.scratch/pre-production-human-steps/README.md),
potwierdzić adresy organów i sprawdzić produkcyjne wdrożenie oraz całość na Androidzie i w przeglądarce.
[DEVELOPMENT.md](DEVELOPMENT.md) opisuje uruchomienie, testy i pozostałe warunki wydania.
Dokumenty planistyczne pod `.scratch/` są częściowo lokalne; świeży klon może ich nie zawierać.

## Licencja

Kod aplikacji jest otwarty, na licencji GNU GPL w wersji 3 lub nowszej. Pełny tekst jest w pliku [LICENSE](LICENSE).
