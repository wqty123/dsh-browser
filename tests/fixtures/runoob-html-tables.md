# Runoob table regression fixture

`runoob-html-tables.html` is the public HTML downloaded from
https://www.runoob.com/html/html-tables.html for the guest proxy regression.
The source markup (including inline scripts) is preserved, with normalized line
endings. It contains the upstream `href = $(this).children("a").attr("href")`
assignment that an attribute regex formerly corrupted inside a script.

The Chromium test serves this document through `handleGuest`, stubs external
resources, and adds observation/capture instrumentation without replacing site
scripts. It checks script integrity, document identity, and native table selection
after navigating away and back. External scripts and ad services are not tested.
