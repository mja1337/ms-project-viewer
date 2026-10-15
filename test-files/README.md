# Test files

Only public or generated sample plans live here. **Never add real or company
project files to this repository.**

## `mpxj/`: from the MPXJ project's test suite

Copied unchanged on 15 Oct 2026 from
https://github.com/joniles/mpxj/tree/master/junit/data (MPXJ, Copyright (c)
Jon Iles and contributors). MPXJ, including these files, is distributed under
the GNU LGPL 2.1; a copy of that licence is in `mpxj/LICENSE`.

| File | Format | Used to check |
| --- | --- | --- |
| `mpp14baseline.mpp` | Project 2010 (MPP14) | outline to 4 levels, links, resources, milestone, % complete |
| `mpp14relations.mpp` | Project 2010 (MPP14) | all four link types (FS, SS, FF, SF) and a lag |
| `mpp14resource.mpp` | Project 2010 (MPP14) | resources and assignments |
| `mpp12relations.mpp` | Project 2007 (MPP12) | links |
| `mpp9relations.mpp` | Project 2000-2003 (MPP9) | links |
| `slack9.mpp` | Project 2000-2003 (MPP9) | 15 links, 3 milestones |
| `mpp8recurring.mpp` | Project 98 (MPP8) | oldest supported version |
| `password-protected-mpp9.mpp` | Project 2000-2003, password protected | the "password protected" error message |
| `mspdirelations.xml` | Project XML (MSPDI) | links via both XML readers |
| `mspdiresource.xml` | Project XML (MSPDI) | resources and assignments via both XML readers |

## `generated/`: made by this repo

`sample-garden-build.xml` is a fictional plan written by
`scripts/gen-sample-mspdi.mjs` (`npm run gen:sample`), covered by this repo's
MIT licence. It has three outline levels, milestones, all four link types,
positive and negative lags, partial progress, and work and material
resources.
