## Deskripsi

Jelaskan apa yang diubah dan kenapa. Sebutkan task/ticket terkait bila ada.

## Periksa (wajib sebelum merge)

- [ ] `npm run typecheck` LULUS (di `cf/`)
- [ ] `npm run test:safety` LULUS
- [ ] `npm run test:logic` LULUS
- [ ] `git grep` pola token bot lama (prefix `8762…` / `AAHK…`) hasil kosong
- [ ] Tidak ada nilai secret/token nyata yang ditambahkan (cek diff!)

## Perubahan kontrak

- [ ] Tidak mengubah binding `wrangler.toml` / migrasi D1
- [ ] Tidak mengubah kontrak URL worker ↔ workflow backend
- [ ] Tidak menambah dependency baru (bila perlu tambah, jelaskan)

## Cuplikan perilaku (opsional)

```
Tulis contoh input → output bila mengubah perilaku runtime.
```

## Daftar periksa

- [ ] Test lokal dijalankan
- [ ] Changelog diperbarui bila perubahan tercatat di `CHANGELOG.md`
- [ ] Bahasa Indonesia konsisten untuk komentar/dok kosong