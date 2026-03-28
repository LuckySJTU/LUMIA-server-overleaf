# Lumia Overleaf TeX Live package manifest

This file is the canonical reference for the extra TeX Live packages already identified while validating Lumia's Overleaf deployment against common ML/NLP templates and the local `lumia.cls` stack.

## Canonical env value

Use this exact value for `OVERLEAF_TEXLIVE_EXTRA_PACKAGES` when rebuilding from scratch:

```bash
OVERLEAF_TEXLIVE_EXTRA_PACKAGES="collection-langcjk microtype tools caption booktabs multirow cleveref mathtools todonotes xcolor hyperref enumitem algorithms algorithmicx natbib url xurl units wrapfig float sttools adjustbox threeparttable tablefootnote soul ulem listings pgf pgfplots siunitx makecell preprint forloop xifthen ifmtarg cmap psnfss textcase changepage datetime fmtcount fancyhdr lastpage titlesec needspace kvoptions tcolorbox fontawesome5 xcharter fontaxes mweights newtx zlmtt extsizes geometry colortbl forest elocalloc changes xstring truncate bclogo mdframed zref lipsum tocloft bbding epigraph nextpage minitoc textgreek cjk greek-fontenc cbfonts cbfonts-fd"
```

## Packages covered

- `collection-langcjk`
- `microtype`
- `tools`
- `caption`
- `booktabs`
- `multirow`
- `cleveref`
- `mathtools`
- `todonotes`
- `xcolor`
- `hyperref`
- `enumitem`
- `algorithms`
- `algorithmicx`
- `natbib`
- `url`
- `xurl`
- `units`
- `wrapfig`
- `float`
- `sttools`
- `adjustbox`
- `threeparttable`
- `tablefootnote`
- `soul`
- `ulem`
- `listings`
- `pgf`
- `pgfplots`
- `siunitx`
- `makecell`
- `preprint`
- `forloop`
- `xifthen`
- `ifmtarg`
- `cmap`
- `psnfss`
- `textcase`
- `changepage`
- `datetime`
- `fmtcount`
- `fancyhdr`
- `lastpage`
- `titlesec`
- `needspace`
- `kvoptions`
- `tcolorbox`
- `fontawesome5`
- `xcharter`
- `fontaxes`
- `mweights`
- `newtx`
- `zlmtt`
- `extsizes`
- `geometry`
- `colortbl`
- `forest`
- `elocalloc`
- `changes`
- `xstring`
- `truncate`
- `bclogo`
- `mdframed`
- `zref`
- `lipsum`
- `tocloft`
- `bbding`
- `epigraph`
- `nextpage`
- `minitoc`
- `textgreek`
- `cjk`
- `greek-fontenc`
- `cbfonts`
- `cbfonts-fd`

## Alias map used by `extend-texlive-image.sh`

These names may appear in user LaTeX sources, but the patch script normalizes them to the actual TeX Live package names:

- `array`, `tabularx`, `xspace`, `afterpage`, `multicol` -> `tools`
- `subcaption` -> `caption`
- `CJKutf8` -> `cjk`
- `tikz` -> `pgf`
- `pifont` -> `psnfss`
- `nicefrac` -> `units`
- `stfloats` -> `sttools`
- `balance` -> `preprint`
- `bibentry` -> `natbib`
- `XCharter` -> `xcharter`
- `newtxmath`, `newtxtext` -> `newtx`
- `extarticle`, `extreport`, `extbook`, `extletter`, `extproc` -> `extsizes`

## Implicit dependency rules used by `extend-texlive-image.sh`

If you ask the patch script to install one of these packages, it also adds the listed dependencies automatically:

- `xifthen` -> `ifmtarg`
- `datetime` -> `fmtcount`
- `xcharter` -> `fontaxes`, `mweights`
- `forest` -> `elocalloc`
- `changes` -> `xstring`, `truncate`
- `mdframed` -> `zref`
- `bclogo` -> `mdframed`, `zref`, `pgf`
- `epigraph` -> `nextpage`
- `textgreek` -> `greek-fontenc`, `cbfonts`, `cbfonts-fd`

## Notes

- Conference style files themselves are still not part of TeX Live. Files such as `icml2026.sty`, `neurips_2026.sty`, `iclr2026_conference.sty`, ACL/EMNLP style files, and similar template assets must remain in the project tree.
- `minted` is intentionally not included here. If you need it later, you also need Python `pygments` plus an allowed `-shell-escape` build path.
