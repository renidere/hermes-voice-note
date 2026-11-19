# Проверки комплекта 0.4.1

## Windows-сборка 0.4.1

Выпуск добавляет portable-клиент Windows x64 с полным SDK/composer patch. Сам `plugin.js` не изменён относительно квалифицированного 0.4.0: изменён канал доставки совместимого клиента, а не ослаблены требования SDK или сохранность WAV.

- GitHub Actions run **44558929604**, workflow commit **2077a0b92e06bdca582088117b0603cedf480839**, стандартный Windows 2025 runner.
- **76/76 SDK tests** (три suites, включая 19 session-lease checks), **101/101 composer tests**, **35/35 plugin unit tests** — PASS на Windows. Наборы не суммируются с прежними Linux-проверками как уникальные tests.
- Штатные Desktop build и упаковка **unsigned Windows x64 ZIP** — PASS. В package проверены PE x64 executable, наличие нового SDK в упакованном renderer и точные hashes всех SDK/composer исходников до и после build.
- Windows dependency acquisition и packaging tools выполнялись без signing secrets и пользовательских profile/config/audio. SDK/composer tests запускались с network-deny preload; plugin tests используют fixture SDK/audio и не вызывают модель.
- Используется существующий вариант **Hermes Light** с commit identity `3b42157`: отдельное имя приложения, remote-only backend и отключённый stable update feed. Upstream base и patch hash закреплены в `windows-client-source.json`; в build stamp сохраняется dirty-признак применённого source patch.
- Скачанный CI ZIP проверен повторно вне runner. Для публикации добавляются лицензии, инструкция и отдельная копия `plugin.js`; исходные файлы Windows-приложения должны остаться побайтно неизменными. `windows-build.json` различает исходный CI package hash и hash публикуемого ZIP.
- Первый workflow был отклонён до runner из-за недоступного `runner` context в job.env. Следующий успешно прошёл tests/build, но упаковка отказала из-за разделённого pnpm аргумента `-c`. Оба failed runs сохранены; исправлены только workflow context и передача аргументов. Защитные проверки core packager не отключались.

**Не подтверждено:** запуск конкретного пользовательского окна, микрофон, реальный старый/переименованный чат и backend/model delivery. ZIP не является официально подписанным MSIX. Windows CI unit/build/package PASS не называется пройденной пользовательской приёмкой.

## Состав исходного парного комплекта

`plugin.js` и patch клиента `install/hermes-desktop-session-transport.patch`. Нужен Desktop с новым `host.retainSession` и исправленным подтверждением composer; одна переустановка плагина не устанавливает SDK. Прежний небезопасный путь отправки удалён. На старом SDK запись не предлагается: показывается требование обновления клиента.

SDK-метод переиспользует штатные native resolver, request router, ambiguity guard и удержание gateway. Плагин фиксирует исходный stored ID и копирует известного owner до первого await; отсутствие owner разрешается native-методом при каждом явном Send. Ошибка сохраняет WAV в памяти, а отмена не отправляет поздний ответ upload.

## Исторические source/fixture-проверки 0.4.0

- **35/35 plugin unit tests**, без fail/skip. Настоящий ESM-модуль, fixture SDK/audio boundaries. Добавлены owner-null → native lease → исходный chat, byte-identical retry, поздний lease после отмены, сохранение известного owner, отказ старого SDK до записи и сохранение WAV после отказа composer. Fixtures переведены на новый SDK-контракт; старый путь маршрутизации из runtime удалён.
- **19/19 SDK checks**: 18 behavioral-кейсов настоящего `session-request.ts` с настоящими native router/guard и контролируемыми owner lookup/transport seams; 1 AST-проверка экспорта `host.retainSession`. AST-проверка не называется полным импортом SDK.
- **101/101 composer checks** в двух существующих suites, включая новый настоящий mounted-hook/SDK regression: main/tile, idle/busy, healthy → inputDisabled → recovery, отсутствующий подписчик, скрытая/чужая поверхность. Черновик и его вложения сохранены. Исторический RED и неизменённый FIRSTGREEN сохранены отдельно от более поздних дополнительных controls.
- Полные существующие SDK import suites `host-state.test.ts` и `profile-routing.test.ts` прошли. Первоначальная ошибка только AST-чтения файла под Vite/jsdom сохранена; после исправления filesystem-пути все 19 SDK checks прошли и в обычном UI-проекте, и в Node-проекте. Это одни и те же 19 проверок, не 38 уникальных.
- Production **Vite renderer build** и полный `tsc -p tsconfig.json --noEmit` прошли. Проверки выполнялись с Node network-deny guard; network-доступ для них не нужен. Это не сборка установщика Windows/Electron.
- Новые поведенческие изменения имеют сохранённые RED → unchanged FIRSTGREEN. Поздние сразу прошедшие controls сохранены как controls, не выданы за исходные RED.
- **DOM**: настоящие `button.click()` в родительской форме jsdom, ноль посторонних form submit, несвязанный черновик сохранён.
- **Chromium capture**: синтетический микрофон → настоящий getUserMedia/WebAudio → WAV → loopback receiver через fixture нового SDK-контракта. FFprobe: PCM16, 48000 Hz, 2 channels; полное декодирование FFmpeg успешно. Это не native Windows.
- **Actual SDK Button/React UI**: обычный/reduced motion, стабильность размеров/DOM, ошибка и retry, изоляция CSS. Host/device/theme — fixtures.
- **Совместный HTTP gate** (`test:native`): настоящий плагин, новый SDK lease и настоящие native sync owner ladder/router/ambiguity guard. Два loopback HTTP-приёмника специально принимают одинаковый stored ID; фокус и primary указывают на чужой source B, native owner — на исходный source A. WAV поступил A, к B **0 запросов**, `composer.submit` получил исходный stored ID.
- В том же gate: HTTP 503 → byte-identical сохранённый WAV → успешный повтор; действительно отсутствующий native owner → отказ до HTTP → последующее восстановление proof → успешная отправка того же WAV. Lease refcounts вернулись к нулю.
- Test config SDK дополнительно проверен с Windows file URL и настоящей Windows-семантикой `fileURLToPath`: сохранены отдельные RED/FIRSTGREEN исправления alias. Это не запуск Vitest на Windows.
- Во всех этих проверках **0 вызовов модельных/речевых провайдеров**. Реальные пользовательские backend, записи, конфигурация и службы не изменялись.

## Не установлено этими проверками

- Store/async REST-discovery владельца и pooled-socket I/O в совместном HTTP gate заменены явно заданными адаптерами. Native sync owner ladder/router/guard и сам SDK lease исполняются настоящие.
- `composer.submit === true` доказывает UI handoff, не backend delivery, ответ модели или итоговое появление сообщения в реальном Windows-чате.
- На этапе 0.4.0 полный импорт SDK, renderer build и TypeScript были проверены без Windows-упаковки. В 0.4.1 ZIP собран на Windows, но запуск конкретного пользовательского окна и активация SDK у пользователя по-прежнему не подтверждены. Правки линтера сохраняют нормализованный JavaScript; подмена assertion специально проверена как отрицательный control.
- Нативный сценарий старого/переименованного чата на конкретном Windows/Electron требует установки нового клиента и проверки там. Нельзя считать его пройденным по Linux/fixture результатам.
- Нет гарантии отсутствия аппаратного DSP, ресемплинга браузера, аналогового клиппинга или потери WAV при закрытии приложения. WAV остаётся в RAM до успешного handoff или явной отмены.
- Не проверены все сетевые/OS-crash сценарии. Нет серверной установки или нового Python backend.

## Публичность

Публикуемые тесты создают только синтетические WAV. Пользовательские записи, внутренние отчёты, profile/config/credentials, private network addresses и установленные зависимости не входят в Git/ZIP. Runtime не требует npm install; React предоставляет Desktop. Подробности изменения клиента и отката: [SDK-UPDATE.ru.md](SDK-UPDATE.ru.md).
