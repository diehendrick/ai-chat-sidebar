import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
print("entries:", len(names))
for n in names:
    print(("  BACKSLASH " if "\\" in n else "  ok        ") + n)
