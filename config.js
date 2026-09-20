/* Настройки своей базы Supabase.
   Эти два значения публичные по замыслу Supabase: ключ сам по себе ничего
   не открывает, доступ к данным закрывает RLS, политика из файла
   supabase.sql. Поэтому файл спокойно лежит в публичном репозитории.

   Где взять: Project Settings, API Keys, строка Publishable key.
   В старых проектах она называется anon public и выглядит как eyJ...
   Оба формата подходят.

   Если оставить значения пустыми, приложение работает локально,
   без синхронизации между устройствами. */
window.WALLET_SUPABASE = {
  url: "https://afoewdpcqnswixorbgmw.supabase.co",
  anonKey: "sb_publishable_c2iHDWW2q9RmW2tiC0w7ag_UMOOwShn"
};
