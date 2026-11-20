import { createRequire } from "node:module";
import { BrowserWindow, Menu, Notification, Tray, WebContentsView, app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, protocol, session, shell, systemPreferences } from "electron";
import fs, { appendFileSync, closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFile, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path, { basename, delimiter, dirname, extname, isAbsolute, join, normalize, resolve, sep, win32 } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fsPromises, { access, lstat, mkdir, mkdtemp, open, readFile as readFile$1, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import url, { fileURLToPath } from "node:url";
import { cpus, homedir, totalmem, userInfo } from "node:os";
import { inspect, promisify } from "node:util";
import { gt, valid } from "semver";
import { Context, Service, composeError } from "@deepseek-ai/cordis";
import { execFile, spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import electronUpdater from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import WebSocket from "ws";
import { REMOTE_STREAM_MUX_PATH, parseRemoteStreamServerMessage } from "@deepseek-ai/dsh-api-gateway/stream-protocol";
//#region ../../node_modules/.pnpm/mime@4.1.1/node_modules/mime/dist/types/other.js
const types$3 = {
	"application/prs.cww": ["cww"],
	"application/prs.xsf+xml": ["xsf"],
	"application/vnd.1000minds.decision-model+xml": ["1km"],
	"application/vnd.3gpp.pic-bw-large": ["plb"],
	"application/vnd.3gpp.pic-bw-small": ["psb"],
	"application/vnd.3gpp.pic-bw-var": ["pvb"],
	"application/vnd.3gpp2.tcap": ["tcap"],
	"application/vnd.3m.post-it-notes": ["pwn"],
	"application/vnd.accpac.simply.aso": ["aso"],
	"application/vnd.accpac.simply.imp": ["imp"],
	"application/vnd.acucobol": ["acu"],
	"application/vnd.acucorp": ["atc", "acutc"],
	"application/vnd.adobe.air-application-installer-package+zip": ["air"],
	"application/vnd.adobe.formscentral.fcdt": ["fcdt"],
	"application/vnd.adobe.fxp": ["fxp", "fxpl"],
	"application/vnd.adobe.xdp+xml": ["xdp"],
	"application/vnd.adobe.xfdf": ["*xfdf"],
	"application/vnd.age": ["age"],
	"application/vnd.ahead.space": ["ahead"],
	"application/vnd.airzip.filesecure.azf": ["azf"],
	"application/vnd.airzip.filesecure.azs": ["azs"],
	"application/vnd.amazon.ebook": ["azw"],
	"application/vnd.americandynamics.acc": ["acc"],
	"application/vnd.amiga.ami": ["ami"],
	"application/vnd.android.package-archive": ["apk"],
	"application/vnd.anser-web-certificate-issue-initiation": ["cii"],
	"application/vnd.anser-web-funds-transfer-initiation": ["fti"],
	"application/vnd.antix.game-component": ["atx"],
	"application/vnd.apple.installer+xml": ["mpkg"],
	"application/vnd.apple.keynote": ["key"],
	"application/vnd.apple.mpegurl": ["m3u8"],
	"application/vnd.apple.numbers": ["numbers"],
	"application/vnd.apple.pages": ["pages"],
	"application/vnd.apple.pkpass": ["pkpass"],
	"application/vnd.aristanetworks.swi": ["swi"],
	"application/vnd.astraea-software.iota": ["iota"],
	"application/vnd.audiograph": ["aep"],
	"application/vnd.autodesk.fbx": ["fbx"],
	"application/vnd.balsamiq.bmml+xml": ["bmml"],
	"application/vnd.blueice.multipass": ["mpm"],
	"application/vnd.bmi": ["bmi"],
	"application/vnd.businessobjects": ["rep"],
	"application/vnd.chemdraw+xml": ["cdxml"],
	"application/vnd.chipnuts.karaoke-mmd": ["mmd"],
	"application/vnd.cinderella": ["cdy"],
	"application/vnd.citationstyles.style+xml": ["csl"],
	"application/vnd.claymore": ["cla"],
	"application/vnd.cloanto.rp9": ["rp9"],
	"application/vnd.clonk.c4group": [
		"c4g",
		"c4d",
		"c4f",
		"c4p",
		"c4u"
	],
	"application/vnd.cluetrust.cartomobile-config": ["c11amc"],
	"application/vnd.cluetrust.cartomobile-config-pkg": ["c11amz"],
	"application/vnd.commonspace": ["csp"],
	"application/vnd.contact.cmsg": ["cdbcmsg"],
	"application/vnd.cosmocaller": ["cmc"],
	"application/vnd.crick.clicker": ["clkx"],
	"application/vnd.crick.clicker.keyboard": ["clkk"],
	"application/vnd.crick.clicker.palette": ["clkp"],
	"application/vnd.crick.clicker.template": ["clkt"],
	"application/vnd.crick.clicker.wordbank": ["clkw"],
	"application/vnd.criticaltools.wbs+xml": ["wbs"],
	"application/vnd.ctc-posml": ["pml"],
	"application/vnd.cups-ppd": ["ppd"],
	"application/vnd.curl.car": ["car"],
	"application/vnd.curl.pcurl": ["pcurl"],
	"application/vnd.dart": ["dart"],
	"application/vnd.data-vision.rdz": ["rdz"],
	"application/vnd.dbf": ["dbf"],
	"application/vnd.dcmp+xml": ["dcmp"],
	"application/vnd.dece.data": [
		"uvf",
		"uvvf",
		"uvd",
		"uvvd"
	],
	"application/vnd.dece.ttml+xml": ["uvt", "uvvt"],
	"application/vnd.dece.unspecified": ["uvx", "uvvx"],
	"application/vnd.dece.zip": ["uvz", "uvvz"],
	"application/vnd.denovo.fcselayout-link": ["fe_launch"],
	"application/vnd.dna": ["dna"],
	"application/vnd.dolby.mlp": ["mlp"],
	"application/vnd.dpgraph": ["dpg"],
	"application/vnd.dreamfactory": ["dfac"],
	"application/vnd.ds-keypoint": ["kpxx"],
	"application/vnd.dvb.ait": ["ait"],
	"application/vnd.dvb.service": ["svc"],
	"application/vnd.dynageo": ["geo"],
	"application/vnd.ecowin.chart": ["mag"],
	"application/vnd.enliven": ["nml"],
	"application/vnd.epson.esf": ["esf"],
	"application/vnd.epson.msf": ["msf"],
	"application/vnd.epson.quickanime": ["qam"],
	"application/vnd.epson.salt": ["slt"],
	"application/vnd.epson.ssf": ["ssf"],
	"application/vnd.eszigno3+xml": ["es3", "et3"],
	"application/vnd.ezpix-album": ["ez2"],
	"application/vnd.ezpix-package": ["ez3"],
	"application/vnd.fdf": ["*fdf"],
	"application/vnd.fdsn.mseed": ["mseed"],
	"application/vnd.fdsn.seed": ["seed", "dataless"],
	"application/vnd.flographit": ["gph"],
	"application/vnd.fluxtime.clip": ["ftc"],
	"application/vnd.framemaker": [
		"fm",
		"frame",
		"maker",
		"book"
	],
	"application/vnd.frogans.fnc": ["fnc"],
	"application/vnd.frogans.ltf": ["ltf"],
	"application/vnd.fsc.weblaunch": ["fsc"],
	"application/vnd.fujitsu.oasys": ["oas"],
	"application/vnd.fujitsu.oasys2": ["oa2"],
	"application/vnd.fujitsu.oasys3": ["oa3"],
	"application/vnd.fujitsu.oasysgp": ["fg5"],
	"application/vnd.fujitsu.oasysprs": ["bh2"],
	"application/vnd.fujixerox.ddd": ["ddd"],
	"application/vnd.fujixerox.docuworks": ["xdw"],
	"application/vnd.fujixerox.docuworks.binder": ["xbd"],
	"application/vnd.fuzzysheet": ["fzs"],
	"application/vnd.genomatix.tuxedo": ["txd"],
	"application/vnd.geogebra.file": ["ggb"],
	"application/vnd.geogebra.slides": ["ggs"],
	"application/vnd.geogebra.tool": ["ggt"],
	"application/vnd.geometry-explorer": ["gex", "gre"],
	"application/vnd.geonext": ["gxt"],
	"application/vnd.geoplan": ["g2w"],
	"application/vnd.geospace": ["g3w"],
	"application/vnd.gmx": ["gmx"],
	"application/vnd.google-apps.document": ["gdoc"],
	"application/vnd.google-apps.drawing": ["gdraw"],
	"application/vnd.google-apps.form": ["gform"],
	"application/vnd.google-apps.jam": ["gjam"],
	"application/vnd.google-apps.map": ["gmap"],
	"application/vnd.google-apps.presentation": ["gslides"],
	"application/vnd.google-apps.script": ["gscript"],
	"application/vnd.google-apps.site": ["gsite"],
	"application/vnd.google-apps.spreadsheet": ["gsheet"],
	"application/vnd.google-earth.kml+xml": ["kml"],
	"application/vnd.google-earth.kmz": ["kmz"],
	"application/vnd.gov.sk.xmldatacontainer+xml": ["xdcf"],
	"application/vnd.grafeq": ["gqf", "gqs"],
	"application/vnd.groove-account": ["gac"],
	"application/vnd.groove-help": ["ghf"],
	"application/vnd.groove-identity-message": ["gim"],
	"application/vnd.groove-injector": ["grv"],
	"application/vnd.groove-tool-message": ["gtm"],
	"application/vnd.groove-tool-template": ["tpl"],
	"application/vnd.groove-vcard": ["vcg"],
	"application/vnd.hal+xml": ["hal"],
	"application/vnd.handheld-entertainment+xml": ["zmm"],
	"application/vnd.hbci": ["hbci"],
	"application/vnd.hhe.lesson-player": ["les"],
	"application/vnd.hp-hpgl": ["hpgl"],
	"application/vnd.hp-hpid": ["hpid"],
	"application/vnd.hp-hps": ["hps"],
	"application/vnd.hp-jlyt": ["jlt"],
	"application/vnd.hp-pcl": ["pcl"],
	"application/vnd.hp-pclxl": ["pclxl"],
	"application/vnd.hydrostatix.sof-data": ["sfd-hdstx"],
	"application/vnd.ibm.minipay": ["mpy"],
	"application/vnd.ibm.modcap": [
		"afp",
		"listafp",
		"list3820"
	],
	"application/vnd.ibm.rights-management": ["irm"],
	"application/vnd.ibm.secure-container": ["sc"],
	"application/vnd.iccprofile": ["icc", "icm"],
	"application/vnd.igloader": ["igl"],
	"application/vnd.immervision-ivp": ["ivp"],
	"application/vnd.immervision-ivu": ["ivu"],
	"application/vnd.insors.igm": ["igm"],
	"application/vnd.intercon.formnet": ["xpw", "xpx"],
	"application/vnd.intergeo": ["i2g"],
	"application/vnd.intu.qbo": ["qbo"],
	"application/vnd.intu.qfx": ["qfx"],
	"application/vnd.ipunplugged.rcprofile": ["rcprofile"],
	"application/vnd.irepository.package+xml": ["irp"],
	"application/vnd.is-xpr": ["xpr"],
	"application/vnd.isac.fcs": ["fcs"],
	"application/vnd.jam": ["jam"],
	"application/vnd.jcp.javame.midlet-rms": ["rms"],
	"application/vnd.jisp": ["jisp"],
	"application/vnd.joost.joda-archive": ["joda"],
	"application/vnd.kahootz": ["ktz", "ktr"],
	"application/vnd.kde.karbon": ["karbon"],
	"application/vnd.kde.kchart": ["chrt"],
	"application/vnd.kde.kformula": ["kfo"],
	"application/vnd.kde.kivio": ["flw"],
	"application/vnd.kde.kontour": ["kon"],
	"application/vnd.kde.kpresenter": ["kpr", "kpt"],
	"application/vnd.kde.kspread": ["ksp"],
	"application/vnd.kde.kword": ["kwd", "kwt"],
	"application/vnd.kenameaapp": ["htke"],
	"application/vnd.kidspiration": ["kia"],
	"application/vnd.kinar": ["kne", "knp"],
	"application/vnd.koan": [
		"skp",
		"skd",
		"skt",
		"skm"
	],
	"application/vnd.kodak-descriptor": ["sse"],
	"application/vnd.las.las+xml": ["lasxml"],
	"application/vnd.llamagraphics.life-balance.desktop": ["lbd"],
	"application/vnd.llamagraphics.life-balance.exchange+xml": ["lbe"],
	"application/vnd.lotus-1-2-3": ["123"],
	"application/vnd.lotus-approach": ["apr"],
	"application/vnd.lotus-freelance": ["pre"],
	"application/vnd.lotus-notes": ["nsf"],
	"application/vnd.lotus-organizer": ["org"],
	"application/vnd.lotus-screencam": ["scm"],
	"application/vnd.lotus-wordpro": ["lwp"],
	"application/vnd.macports.portpkg": ["portpkg"],
	"application/vnd.mapbox-vector-tile": ["mvt"],
	"application/vnd.mcd": ["mcd"],
	"application/vnd.medcalcdata": ["mc1"],
	"application/vnd.mediastation.cdkey": ["cdkey"],
	"application/vnd.mfer": ["mwf"],
	"application/vnd.mfmp": ["mfm"],
	"application/vnd.micrografx.flo": ["flo"],
	"application/vnd.micrografx.igx": ["igx"],
	"application/vnd.mif": ["mif"],
	"application/vnd.mobius.daf": ["daf"],
	"application/vnd.mobius.dis": ["dis"],
	"application/vnd.mobius.mbk": ["mbk"],
	"application/vnd.mobius.mqy": ["mqy"],
	"application/vnd.mobius.msl": ["msl"],
	"application/vnd.mobius.plc": ["plc"],
	"application/vnd.mobius.txf": ["txf"],
	"application/vnd.mophun.application": ["mpn"],
	"application/vnd.mophun.certificate": ["mpc"],
	"application/vnd.mozilla.xul+xml": ["xul"],
	"application/vnd.ms-artgalry": ["cil"],
	"application/vnd.ms-cab-compressed": ["cab"],
	"application/vnd.ms-excel": [
		"xls",
		"xlm",
		"xla",
		"xlc",
		"xlt",
		"xlw"
	],
	"application/vnd.ms-excel.addin.macroenabled.12": ["xlam"],
	"application/vnd.ms-excel.sheet.binary.macroenabled.12": ["xlsb"],
	"application/vnd.ms-excel.sheet.macroenabled.12": ["xlsm"],
	"application/vnd.ms-excel.template.macroenabled.12": ["xltm"],
	"application/vnd.ms-fontobject": ["eot"],
	"application/vnd.ms-htmlhelp": ["chm"],
	"application/vnd.ms-ims": ["ims"],
	"application/vnd.ms-lrm": ["lrm"],
	"application/vnd.ms-officetheme": ["thmx"],
	"application/vnd.ms-outlook": ["msg"],
	"application/vnd.ms-pki.seccat": ["cat"],
	"application/vnd.ms-pki.stl": ["*stl"],
	"application/vnd.ms-powerpoint": [
		"ppt",
		"pps",
		"pot"
	],
	"application/vnd.ms-powerpoint.addin.macroenabled.12": ["ppam"],
	"application/vnd.ms-powerpoint.presentation.macroenabled.12": ["pptm"],
	"application/vnd.ms-powerpoint.slide.macroenabled.12": ["sldm"],
	"application/vnd.ms-powerpoint.slideshow.macroenabled.12": ["ppsm"],
	"application/vnd.ms-powerpoint.template.macroenabled.12": ["potm"],
	"application/vnd.ms-project": ["*mpp", "mpt"],
	"application/vnd.ms-visio.viewer": ["vdx"],
	"application/vnd.ms-word.document.macroenabled.12": ["docm"],
	"application/vnd.ms-word.template.macroenabled.12": ["dotm"],
	"application/vnd.ms-works": [
		"wps",
		"wks",
		"wcm",
		"wdb"
	],
	"application/vnd.ms-wpl": ["wpl"],
	"application/vnd.ms-xpsdocument": ["xps"],
	"application/vnd.mseq": ["mseq"],
	"application/vnd.musician": ["mus"],
	"application/vnd.muvee.style": ["msty"],
	"application/vnd.mynfc": ["taglet"],
	"application/vnd.nato.bindingdataobject+xml": ["bdo"],
	"application/vnd.neurolanguage.nlu": ["nlu"],
	"application/vnd.nitf": ["ntf", "nitf"],
	"application/vnd.noblenet-directory": ["nnd"],
	"application/vnd.noblenet-sealer": ["nns"],
	"application/vnd.noblenet-web": ["nnw"],
	"application/vnd.nokia.n-gage.ac+xml": ["*ac"],
	"application/vnd.nokia.n-gage.data": ["ngdat"],
	"application/vnd.nokia.n-gage.symbian.install": ["n-gage"],
	"application/vnd.nokia.radio-preset": ["rpst"],
	"application/vnd.nokia.radio-presets": ["rpss"],
	"application/vnd.novadigm.edm": ["edm"],
	"application/vnd.novadigm.edx": ["edx"],
	"application/vnd.novadigm.ext": ["ext"],
	"application/vnd.oasis.opendocument.chart": ["odc"],
	"application/vnd.oasis.opendocument.chart-template": ["otc"],
	"application/vnd.oasis.opendocument.database": ["odb"],
	"application/vnd.oasis.opendocument.formula": ["odf"],
	"application/vnd.oasis.opendocument.formula-template": ["odft"],
	"application/vnd.oasis.opendocument.graphics": ["odg"],
	"application/vnd.oasis.opendocument.graphics-template": ["otg"],
	"application/vnd.oasis.opendocument.image": ["odi"],
	"application/vnd.oasis.opendocument.image-template": ["oti"],
	"application/vnd.oasis.opendocument.presentation": ["odp"],
	"application/vnd.oasis.opendocument.presentation-template": ["otp"],
	"application/vnd.oasis.opendocument.spreadsheet": ["ods"],
	"application/vnd.oasis.opendocument.spreadsheet-template": ["ots"],
	"application/vnd.oasis.opendocument.text": ["odt"],
	"application/vnd.oasis.opendocument.text-master": ["odm"],
	"application/vnd.oasis.opendocument.text-template": ["ott"],
	"application/vnd.oasis.opendocument.text-web": ["oth"],
	"application/vnd.olpc-sugar": ["xo"],
	"application/vnd.oma.dd2+xml": ["dd2"],
	"application/vnd.openblox.game+xml": ["obgx"],
	"application/vnd.openofficeorg.extension": ["oxt"],
	"application/vnd.openstreetmap.data+xml": ["osm"],
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
	"application/vnd.openxmlformats-officedocument.presentationml.slide": ["sldx"],
	"application/vnd.openxmlformats-officedocument.presentationml.slideshow": ["ppsx"],
	"application/vnd.openxmlformats-officedocument.presentationml.template": ["potx"],
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
	"application/vnd.openxmlformats-officedocument.spreadsheetml.template": ["xltx"],
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
	"application/vnd.openxmlformats-officedocument.wordprocessingml.template": ["dotx"],
	"application/vnd.osgeo.mapguide.package": ["mgp"],
	"application/vnd.osgi.dp": ["dp"],
	"application/vnd.osgi.subsystem": ["esa"],
	"application/vnd.palm": [
		"pdb",
		"pqa",
		"oprc"
	],
	"application/vnd.pawaafile": ["paw"],
	"application/vnd.pg.format": ["str"],
	"application/vnd.pg.osasli": ["ei6"],
	"application/vnd.picsel": ["efif"],
	"application/vnd.pmi.widget": ["wg"],
	"application/vnd.pocketlearn": ["plf"],
	"application/vnd.powerbuilder6": ["pbd"],
	"application/vnd.previewsystems.box": ["box"],
	"application/vnd.procrate.brushset": ["brushset"],
	"application/vnd.procreate.brush": ["brush"],
	"application/vnd.procreate.dream": ["drm"],
	"application/vnd.proteus.magazine": ["mgz"],
	"application/vnd.publishare-delta-tree": ["qps"],
	"application/vnd.pvi.ptid1": ["ptid"],
	"application/vnd.pwg-xhtml-print+xml": ["xhtm"],
	"application/vnd.quark.quarkxpress": [
		"qxd",
		"qxt",
		"qwd",
		"qwt",
		"qxl",
		"qxb"
	],
	"application/vnd.rar": ["rar"],
	"application/vnd.realvnc.bed": ["bed"],
	"application/vnd.recordare.musicxml": ["mxl"],
	"application/vnd.recordare.musicxml+xml": ["musicxml"],
	"application/vnd.rig.cryptonote": ["cryptonote"],
	"application/vnd.rim.cod": ["cod"],
	"application/vnd.rn-realmedia": ["rm"],
	"application/vnd.rn-realmedia-vbr": ["rmvb"],
	"application/vnd.route66.link66+xml": ["link66"],
	"application/vnd.sailingtracker.track": ["st"],
	"application/vnd.seemail": ["see"],
	"application/vnd.sema": ["sema"],
	"application/vnd.semd": ["semd"],
	"application/vnd.semf": ["semf"],
	"application/vnd.shana.informed.formdata": ["ifm"],
	"application/vnd.shana.informed.formtemplate": ["itp"],
	"application/vnd.shana.informed.interchange": ["iif"],
	"application/vnd.shana.informed.package": ["ipk"],
	"application/vnd.simtech-mindmapper": ["twd", "twds"],
	"application/vnd.smaf": ["mmf"],
	"application/vnd.smart.teacher": ["teacher"],
	"application/vnd.software602.filler.form+xml": ["fo"],
	"application/vnd.solent.sdkm+xml": ["sdkm", "sdkd"],
	"application/vnd.spotfire.dxp": ["dxp"],
	"application/vnd.spotfire.sfs": ["sfs"],
	"application/vnd.stardivision.calc": ["sdc"],
	"application/vnd.stardivision.draw": ["sda"],
	"application/vnd.stardivision.impress": ["sdd"],
	"application/vnd.stardivision.math": ["smf"],
	"application/vnd.stardivision.writer": ["sdw", "vor"],
	"application/vnd.stardivision.writer-global": ["sgl"],
	"application/vnd.stepmania.package": ["smzip"],
	"application/vnd.stepmania.stepchart": ["sm"],
	"application/vnd.sun.wadl+xml": ["wadl"],
	"application/vnd.sun.xml.calc": ["sxc"],
	"application/vnd.sun.xml.calc.template": ["stc"],
	"application/vnd.sun.xml.draw": ["sxd"],
	"application/vnd.sun.xml.draw.template": ["std"],
	"application/vnd.sun.xml.impress": ["sxi"],
	"application/vnd.sun.xml.impress.template": ["sti"],
	"application/vnd.sun.xml.math": ["sxm"],
	"application/vnd.sun.xml.writer": ["sxw"],
	"application/vnd.sun.xml.writer.global": ["sxg"],
	"application/vnd.sun.xml.writer.template": ["stw"],
	"application/vnd.sus-calendar": ["sus", "susp"],
	"application/vnd.svd": ["svd"],
	"application/vnd.symbian.install": ["sis", "sisx"],
	"application/vnd.syncml+xml": ["xsm"],
	"application/vnd.syncml.dm+wbxml": ["bdm"],
	"application/vnd.syncml.dm+xml": ["xdm"],
	"application/vnd.syncml.dmddf+xml": ["ddf"],
	"application/vnd.tao.intent-module-archive": ["tao"],
	"application/vnd.tcpdump.pcap": [
		"pcap",
		"cap",
		"dmp"
	],
	"application/vnd.tmobile-livetv": ["tmo"],
	"application/vnd.trid.tpt": ["tpt"],
	"application/vnd.triscape.mxs": ["mxs"],
	"application/vnd.trueapp": ["tra"],
	"application/vnd.ufdl": ["ufd", "ufdl"],
	"application/vnd.uiq.theme": ["utz"],
	"application/vnd.umajin": ["umj"],
	"application/vnd.unity": ["unityweb"],
	"application/vnd.uoml+xml": ["uoml", "uo"],
	"application/vnd.vcx": ["vcx"],
	"application/vnd.visio": [
		"vsd",
		"vst",
		"vss",
		"vsw",
		"vsdx",
		"vtx"
	],
	"application/vnd.visionary": ["vis"],
	"application/vnd.vsf": ["vsf"],
	"application/vnd.wap.wbxml": ["wbxml"],
	"application/vnd.wap.wmlc": ["wmlc"],
	"application/vnd.wap.wmlscriptc": ["wmlsc"],
	"application/vnd.webturbo": ["wtb"],
	"application/vnd.wolfram.player": ["nbp"],
	"application/vnd.wordperfect": ["wpd"],
	"application/vnd.wqd": ["wqd"],
	"application/vnd.wt.stf": ["stf"],
	"application/vnd.xara": ["xar"],
	"application/vnd.xfdl": ["xfdl"],
	"application/vnd.yamaha.hv-dic": ["hvd"],
	"application/vnd.yamaha.hv-script": ["hvs"],
	"application/vnd.yamaha.hv-voice": ["hvp"],
	"application/vnd.yamaha.openscoreformat": ["osf"],
	"application/vnd.yamaha.openscoreformat.osfpvg+xml": ["osfpvg"],
	"application/vnd.yamaha.smaf-audio": ["saf"],
	"application/vnd.yamaha.smaf-phrase": ["spf"],
	"application/vnd.yellowriver-custom-menu": ["cmp"],
	"application/vnd.zul": ["zir", "zirz"],
	"application/vnd.zzazz.deck+xml": ["zaz"],
	"application/x-7z-compressed": ["7z"],
	"application/x-abiword": ["abw"],
	"application/x-ace-compressed": ["ace"],
	"application/x-apple-diskimage": ["*dmg"],
	"application/x-arj": ["arj"],
	"application/x-authorware-bin": [
		"aab",
		"x32",
		"u32",
		"vox"
	],
	"application/x-authorware-map": ["aam"],
	"application/x-authorware-seg": ["aas"],
	"application/x-bcpio": ["bcpio"],
	"application/x-bdoc": ["*bdoc"],
	"application/x-bittorrent": ["torrent"],
	"application/x-blender": ["blend"],
	"application/x-blorb": ["blb", "blorb"],
	"application/x-bzip": ["bz"],
	"application/x-bzip2": ["bz2", "boz"],
	"application/x-cbr": [
		"cbr",
		"cba",
		"cbt",
		"cbz",
		"cb7"
	],
	"application/x-cdlink": ["vcd"],
	"application/x-cfs-compressed": ["cfs"],
	"application/x-chat": ["chat"],
	"application/x-chess-pgn": ["pgn"],
	"application/x-chrome-extension": ["crx"],
	"application/x-cocoa": ["cco"],
	"application/x-compressed": ["*rar"],
	"application/x-conference": ["nsc"],
	"application/x-cpio": ["cpio"],
	"application/x-csh": ["csh"],
	"application/x-debian-package": ["*deb", "udeb"],
	"application/x-dgc-compressed": ["dgc"],
	"application/x-director": [
		"dir",
		"dcr",
		"dxr",
		"cst",
		"cct",
		"cxt",
		"w3d",
		"fgd",
		"swa"
	],
	"application/x-doom": ["wad"],
	"application/x-dtbncx+xml": ["ncx"],
	"application/x-dtbook+xml": ["dtb"],
	"application/x-dtbresource+xml": ["res"],
	"application/x-dvi": ["dvi"],
	"application/x-envoy": ["evy"],
	"application/x-eva": ["eva"],
	"application/x-font-bdf": ["bdf"],
	"application/x-font-ghostscript": ["gsf"],
	"application/x-font-linux-psf": ["psf"],
	"application/x-font-pcf": ["pcf"],
	"application/x-font-snf": ["snf"],
	"application/x-font-type1": [
		"pfa",
		"pfb",
		"pfm",
		"afm"
	],
	"application/x-freearc": ["arc"],
	"application/x-futuresplash": ["spl"],
	"application/x-gca-compressed": ["gca"],
	"application/x-glulx": ["ulx"],
	"application/x-gnumeric": ["gnumeric"],
	"application/x-gramps-xml": ["gramps"],
	"application/x-gtar": ["gtar"],
	"application/x-hdf": ["hdf"],
	"application/x-httpd-php": ["php"],
	"application/x-install-instructions": ["install"],
	"application/x-ipynb+json": ["ipynb"],
	"application/x-iso9660-image": ["*iso"],
	"application/x-iwork-keynote-sffkey": ["*key"],
	"application/x-iwork-numbers-sffnumbers": ["*numbers"],
	"application/x-iwork-pages-sffpages": ["*pages"],
	"application/x-java-archive-diff": ["jardiff"],
	"application/x-java-jnlp-file": ["jnlp"],
	"application/x-keepass2": ["kdbx"],
	"application/x-latex": ["latex"],
	"application/x-lua-bytecode": ["luac"],
	"application/x-lzh-compressed": ["lzh", "lha"],
	"application/x-makeself": ["run"],
	"application/x-mie": ["mie"],
	"application/x-mobipocket-ebook": ["*prc", "mobi"],
	"application/x-ms-application": ["application"],
	"application/x-ms-shortcut": ["lnk"],
	"application/x-ms-wmd": ["wmd"],
	"application/x-ms-wmz": ["wmz"],
	"application/x-ms-xbap": ["xbap"],
	"application/x-msaccess": ["mdb"],
	"application/x-msbinder": ["obd"],
	"application/x-mscardfile": ["crd"],
	"application/x-msclip": ["clp"],
	"application/x-msdos-program": ["*exe"],
	"application/x-msdownload": [
		"*exe",
		"*dll",
		"com",
		"bat",
		"*msi"
	],
	"application/x-msmediaview": [
		"mvb",
		"m13",
		"m14"
	],
	"application/x-msmetafile": [
		"*wmf",
		"*wmz",
		"*emf",
		"emz"
	],
	"application/x-msmoney": ["mny"],
	"application/x-mspublisher": ["pub"],
	"application/x-msschedule": ["scd"],
	"application/x-msterminal": ["trm"],
	"application/x-mswrite": ["wri"],
	"application/x-netcdf": ["nc", "cdf"],
	"application/x-ns-proxy-autoconfig": ["pac"],
	"application/x-nzb": ["nzb"],
	"application/x-perl": ["pl", "pm"],
	"application/x-pilot": ["*prc", "*pdb"],
	"application/x-pkcs12": ["p12", "pfx"],
	"application/x-pkcs7-certificates": ["p7b", "spc"],
	"application/x-pkcs7-certreqresp": ["p7r"],
	"application/x-rar-compressed": ["*rar"],
	"application/x-redhat-package-manager": ["rpm"],
	"application/x-research-info-systems": ["ris"],
	"application/x-sea": ["sea"],
	"application/x-sh": ["sh"],
	"application/x-shar": ["shar"],
	"application/x-shockwave-flash": ["swf"],
	"application/x-silverlight-app": ["xap"],
	"application/x-sql": ["*sql"],
	"application/x-stuffit": ["sit"],
	"application/x-stuffitx": ["sitx"],
	"application/x-subrip": ["srt"],
	"application/x-sv4cpio": ["sv4cpio"],
	"application/x-sv4crc": ["sv4crc"],
	"application/x-t3vm-image": ["t3"],
	"application/x-tads": ["gam"],
	"application/x-tar": ["tar"],
	"application/x-tcl": ["tcl", "tk"],
	"application/x-tex": ["tex"],
	"application/x-tex-tfm": ["tfm"],
	"application/x-texinfo": ["texinfo", "texi"],
	"application/x-tgif": ["*obj"],
	"application/x-ustar": ["ustar"],
	"application/x-virtualbox-hdd": ["hdd"],
	"application/x-virtualbox-ova": ["ova"],
	"application/x-virtualbox-ovf": ["ovf"],
	"application/x-virtualbox-vbox": ["vbox"],
	"application/x-virtualbox-vbox-extpack": ["vbox-extpack"],
	"application/x-virtualbox-vdi": ["vdi"],
	"application/x-virtualbox-vhd": ["vhd"],
	"application/x-virtualbox-vmdk": ["vmdk"],
	"application/x-wais-source": ["src"],
	"application/x-web-app-manifest+json": ["webapp"],
	"application/x-x509-ca-cert": [
		"der",
		"crt",
		"pem"
	],
	"application/x-xfig": ["fig"],
	"application/x-xliff+xml": ["*xlf"],
	"application/x-xpinstall": ["xpi"],
	"application/x-xz": ["xz"],
	"application/x-zip-compressed": ["*zip"],
	"application/x-zmachine": [
		"z1",
		"z2",
		"z3",
		"z4",
		"z5",
		"z6",
		"z7",
		"z8"
	],
	"audio/vnd.dece.audio": ["uva", "uvva"],
	"audio/vnd.digital-winds": ["eol"],
	"audio/vnd.dra": ["dra"],
	"audio/vnd.dts": ["dts"],
	"audio/vnd.dts.hd": ["dtshd"],
	"audio/vnd.lucent.voice": ["lvp"],
	"audio/vnd.ms-playready.media.pya": ["pya"],
	"audio/vnd.nuera.ecelp4800": ["ecelp4800"],
	"audio/vnd.nuera.ecelp7470": ["ecelp7470"],
	"audio/vnd.nuera.ecelp9600": ["ecelp9600"],
	"audio/vnd.rip": ["rip"],
	"audio/x-aac": ["*aac"],
	"audio/x-aiff": [
		"aif",
		"aiff",
		"aifc"
	],
	"audio/x-caf": ["caf"],
	"audio/x-flac": ["flac"],
	"audio/x-m4a": ["*m4a"],
	"audio/x-matroska": ["mka"],
	"audio/x-mpegurl": ["m3u"],
	"audio/x-ms-wax": ["wax"],
	"audio/x-ms-wma": ["wma"],
	"audio/x-pn-realaudio": ["ram", "ra"],
	"audio/x-pn-realaudio-plugin": ["rmp"],
	"audio/x-realaudio": ["*ra"],
	"audio/x-wav": ["*wav"],
	"chemical/x-cdx": ["cdx"],
	"chemical/x-cif": ["cif"],
	"chemical/x-cmdf": ["cmdf"],
	"chemical/x-cml": ["cml"],
	"chemical/x-csml": ["csml"],
	"chemical/x-xyz": ["xyz"],
	"image/prs.btif": ["btif", "btf"],
	"image/prs.pti": ["pti"],
	"image/vnd.adobe.photoshop": ["psd"],
	"image/vnd.airzip.accelerator.azv": ["azv"],
	"image/vnd.blockfact.facti": ["facti"],
	"image/vnd.dece.graphic": [
		"uvi",
		"uvvi",
		"uvg",
		"uvvg"
	],
	"image/vnd.djvu": ["djvu", "djv"],
	"image/vnd.dvb.subtitle": ["*sub"],
	"image/vnd.dwg": ["dwg"],
	"image/vnd.dxf": ["dxf"],
	"image/vnd.fastbidsheet": ["fbs"],
	"image/vnd.fpx": ["fpx"],
	"image/vnd.fst": ["fst"],
	"image/vnd.fujixerox.edmics-mmr": ["mmr"],
	"image/vnd.fujixerox.edmics-rlc": ["rlc"],
	"image/vnd.microsoft.icon": ["ico"],
	"image/vnd.ms-dds": ["dds"],
	"image/vnd.ms-modi": ["mdi"],
	"image/vnd.ms-photo": ["wdp"],
	"image/vnd.net-fpx": ["npx"],
	"image/vnd.pco.b16": ["b16"],
	"image/vnd.tencent.tap": ["tap"],
	"image/vnd.valve.source.texture": ["vtf"],
	"image/vnd.wap.wbmp": ["wbmp"],
	"image/vnd.xiff": ["xif"],
	"image/vnd.zbrush.pcx": ["pcx"],
	"image/x-3ds": ["3ds"],
	"image/x-adobe-dng": ["dng"],
	"image/x-cmu-raster": ["ras"],
	"image/x-cmx": ["cmx"],
	"image/x-freehand": [
		"fh",
		"fhc",
		"fh4",
		"fh5",
		"fh7"
	],
	"image/x-icon": ["*ico"],
	"image/x-jng": ["jng"],
	"image/x-mrsid-image": ["sid"],
	"image/x-ms-bmp": ["*bmp"],
	"image/x-pcx": ["*pcx"],
	"image/x-pict": ["pic", "pct"],
	"image/x-portable-anymap": ["pnm"],
	"image/x-portable-bitmap": ["pbm"],
	"image/x-portable-graymap": ["pgm"],
	"image/x-portable-pixmap": ["ppm"],
	"image/x-rgb": ["rgb"],
	"image/x-tga": ["tga"],
	"image/x-xbitmap": ["xbm"],
	"image/x-xpixmap": ["xpm"],
	"image/x-xwindowdump": ["xwd"],
	"message/vnd.wfa.wsc": ["wsc"],
	"model/vnd.bary": ["bary"],
	"model/vnd.cld": ["cld"],
	"model/vnd.collada+xml": ["dae"],
	"model/vnd.dwf": ["dwf"],
	"model/vnd.gdl": ["gdl"],
	"model/vnd.gtw": ["gtw"],
	"model/vnd.mts": ["*mts"],
	"model/vnd.opengex": ["ogex"],
	"model/vnd.parasolid.transmit.binary": ["x_b"],
	"model/vnd.parasolid.transmit.text": ["x_t"],
	"model/vnd.pytha.pyox": ["pyo", "pyox"],
	"model/vnd.sap.vds": ["vds"],
	"model/vnd.usda": ["usda"],
	"model/vnd.usdz+zip": ["usdz"],
	"model/vnd.valve.source.compiled-map": ["bsp"],
	"model/vnd.vtu": ["vtu"],
	"text/prs.lines.tag": ["dsc"],
	"text/vnd.curl": ["curl"],
	"text/vnd.curl.dcurl": ["dcurl"],
	"text/vnd.curl.mcurl": ["mcurl"],
	"text/vnd.curl.scurl": ["scurl"],
	"text/vnd.dvb.subtitle": ["sub"],
	"text/vnd.familysearch.gedcom": ["ged"],
	"text/vnd.fly": ["fly"],
	"text/vnd.fmi.flexstor": ["flx"],
	"text/vnd.graphviz": ["gv"],
	"text/vnd.in3d.3dml": ["3dml"],
	"text/vnd.in3d.spot": ["spot"],
	"text/vnd.sun.j2me.app-descriptor": ["jad"],
	"text/vnd.wap.wml": ["wml"],
	"text/vnd.wap.wmlscript": ["wmls"],
	"text/x-asm": ["s", "asm"],
	"text/x-c": [
		"c",
		"cc",
		"cxx",
		"cpp",
		"h",
		"hh",
		"dic"
	],
	"text/x-component": ["htc"],
	"text/x-fortran": [
		"f",
		"for",
		"f77",
		"f90"
	],
	"text/x-handlebars-template": ["hbs"],
	"text/x-java-source": ["java"],
	"text/x-lua": ["lua"],
	"text/x-markdown": ["mkd"],
	"text/x-nfo": ["nfo"],
	"text/x-opml": ["opml"],
	"text/x-org": ["*org"],
	"text/x-pascal": ["p", "pas"],
	"text/x-processing": ["pde"],
	"text/x-sass": ["sass"],
	"text/x-scss": ["scss"],
	"text/x-setext": ["etx"],
	"text/x-sfv": ["sfv"],
	"text/x-suse-ymp": ["ymp"],
	"text/x-uuencode": ["uu"],
	"text/x-vcalendar": ["vcs"],
	"text/x-vcard": ["vcf"],
	"video/vnd.dece.hd": ["uvh", "uvvh"],
	"video/vnd.dece.mobile": ["uvm", "uvvm"],
	"video/vnd.dece.pd": ["uvp", "uvvp"],
	"video/vnd.dece.sd": ["uvs", "uvvs"],
	"video/vnd.dece.video": ["uvv", "uvvv"],
	"video/vnd.dvb.file": ["dvb"],
	"video/vnd.fvt": ["fvt"],
	"video/vnd.mpegurl": ["mxu", "m4u"],
	"video/vnd.ms-playready.media.pyv": ["pyv"],
	"video/vnd.uvvu.mp4": ["uvu", "uvvu"],
	"video/vnd.vivo": ["viv"],
	"video/x-f4v": ["f4v"],
	"video/x-fli": ["fli"],
	"video/x-flv": ["flv"],
	"video/x-m4v": ["m4v"],
	"video/x-matroska": [
		"mkv",
		"mk3d",
		"mks"
	],
	"video/x-mng": ["mng"],
	"video/x-ms-asf": ["asf", "asx"],
	"video/x-ms-vob": ["vob"],
	"video/x-ms-wm": ["wm"],
	"video/x-ms-wmv": ["wmv"],
	"video/x-ms-wmx": ["wmx"],
	"video/x-ms-wvx": ["wvx"],
	"video/x-msvideo": ["avi"],
	"video/x-sgi-movie": ["movie"],
	"video/x-smv": ["smv"],
	"x-conference/x-cooltalk": ["ice"]
};
Object.freeze(types$3);
//#endregion
//#region ../../node_modules/.pnpm/mime@4.1.1/node_modules/mime/dist/types/standard.js
const types$2 = {
	"application/andrew-inset": ["ez"],
	"application/appinstaller": ["appinstaller"],
	"application/applixware": ["aw"],
	"application/appx": ["appx"],
	"application/appxbundle": ["appxbundle"],
	"application/atom+xml": ["atom"],
	"application/atomcat+xml": ["atomcat"],
	"application/atomdeleted+xml": ["atomdeleted"],
	"application/atomsvc+xml": ["atomsvc"],
	"application/atsc-dwd+xml": ["dwd"],
	"application/atsc-held+xml": ["held"],
	"application/atsc-rsat+xml": ["rsat"],
	"application/automationml-aml+xml": ["aml"],
	"application/automationml-amlx+zip": ["amlx"],
	"application/bdoc": ["bdoc"],
	"application/calendar+xml": ["xcs"],
	"application/ccxml+xml": ["ccxml"],
	"application/cdfx+xml": ["cdfx"],
	"application/cdmi-capability": ["cdmia"],
	"application/cdmi-container": ["cdmic"],
	"application/cdmi-domain": ["cdmid"],
	"application/cdmi-object": ["cdmio"],
	"application/cdmi-queue": ["cdmiq"],
	"application/cpl+xml": ["cpl"],
	"application/cu-seeme": ["cu"],
	"application/cwl": ["cwl"],
	"application/dash+xml": ["mpd"],
	"application/dash-patch+xml": ["mpp"],
	"application/davmount+xml": ["davmount"],
	"application/dicom": ["dcm"],
	"application/docbook+xml": ["dbk"],
	"application/dssc+der": ["dssc"],
	"application/dssc+xml": ["xdssc"],
	"application/ecmascript": ["ecma"],
	"application/emma+xml": ["emma"],
	"application/emotionml+xml": ["emotionml"],
	"application/epub+zip": ["epub"],
	"application/exi": ["exi"],
	"application/express": ["exp"],
	"application/fdf": ["fdf"],
	"application/fdt+xml": ["fdt"],
	"application/font-tdpfr": ["pfr"],
	"application/geo+json": ["geojson"],
	"application/gml+xml": ["gml"],
	"application/gpx+xml": ["gpx"],
	"application/gxf": ["gxf"],
	"application/gzip": ["gz"],
	"application/hjson": ["hjson"],
	"application/hyperstudio": ["stk"],
	"application/inkml+xml": ["ink", "inkml"],
	"application/ipfix": ["ipfix"],
	"application/its+xml": ["its"],
	"application/java-archive": [
		"jar",
		"war",
		"ear"
	],
	"application/java-serialized-object": ["ser"],
	"application/java-vm": ["class"],
	"application/javascript": ["*js"],
	"application/json": ["json", "map"],
	"application/json5": ["json5"],
	"application/jsonml+json": ["jsonml"],
	"application/ld+json": ["jsonld"],
	"application/lgr+xml": ["lgr"],
	"application/lost+xml": ["lostxml"],
	"application/mac-binhex40": ["hqx"],
	"application/mac-compactpro": ["cpt"],
	"application/mads+xml": ["mads"],
	"application/manifest+json": ["webmanifest"],
	"application/marc": ["mrc"],
	"application/marcxml+xml": ["mrcx"],
	"application/mathematica": [
		"ma",
		"nb",
		"mb"
	],
	"application/mathml+xml": ["mathml"],
	"application/mbox": ["mbox"],
	"application/media-policy-dataset+xml": ["mpf"],
	"application/mediaservercontrol+xml": ["mscml"],
	"application/metalink+xml": ["metalink"],
	"application/metalink4+xml": ["meta4"],
	"application/mets+xml": ["mets"],
	"application/mmt-aei+xml": ["maei"],
	"application/mmt-usd+xml": ["musd"],
	"application/mods+xml": ["mods"],
	"application/mp21": ["m21", "mp21"],
	"application/mp4": [
		"*mp4",
		"*mpg4",
		"mp4s",
		"m4p"
	],
	"application/msix": ["msix"],
	"application/msixbundle": ["msixbundle"],
	"application/msword": ["doc", "dot"],
	"application/mxf": ["mxf"],
	"application/n-quads": ["nq"],
	"application/n-triples": ["nt"],
	"application/node": ["cjs"],
	"application/octet-stream": [
		"bin",
		"dms",
		"lrf",
		"mar",
		"so",
		"dist",
		"distz",
		"pkg",
		"bpk",
		"dump",
		"elc",
		"deploy",
		"exe",
		"dll",
		"deb",
		"dmg",
		"iso",
		"img",
		"msi",
		"msp",
		"msm",
		"buffer"
	],
	"application/oda": ["oda"],
	"application/oebps-package+xml": ["opf"],
	"application/ogg": ["ogx"],
	"application/omdoc+xml": ["omdoc"],
	"application/onenote": [
		"onetoc",
		"onetoc2",
		"onetmp",
		"onepkg",
		"one",
		"onea"
	],
	"application/oxps": ["oxps"],
	"application/p2p-overlay+xml": ["relo"],
	"application/patch-ops-error+xml": ["xer"],
	"application/pdf": ["pdf"],
	"application/pgp-encrypted": ["pgp"],
	"application/pgp-keys": ["asc"],
	"application/pgp-signature": ["sig", "*asc"],
	"application/pics-rules": ["prf"],
	"application/pkcs10": ["p10"],
	"application/pkcs7-mime": ["p7m", "p7c"],
	"application/pkcs7-signature": ["p7s"],
	"application/pkcs8": ["p8"],
	"application/pkix-attr-cert": ["ac"],
	"application/pkix-cert": ["cer"],
	"application/pkix-crl": ["crl"],
	"application/pkix-pkipath": ["pkipath"],
	"application/pkixcmp": ["pki"],
	"application/pls+xml": ["pls"],
	"application/postscript": [
		"ai",
		"eps",
		"ps"
	],
	"application/provenance+xml": ["provx"],
	"application/pskc+xml": ["pskcxml"],
	"application/raml+yaml": ["raml"],
	"application/rdf+xml": ["rdf", "owl"],
	"application/reginfo+xml": ["rif"],
	"application/relax-ng-compact-syntax": ["rnc"],
	"application/resource-lists+xml": ["rl"],
	"application/resource-lists-diff+xml": ["rld"],
	"application/rls-services+xml": ["rs"],
	"application/route-apd+xml": ["rapd"],
	"application/route-s-tsid+xml": ["sls"],
	"application/route-usd+xml": ["rusd"],
	"application/rpki-ghostbusters": ["gbr"],
	"application/rpki-manifest": ["mft"],
	"application/rpki-roa": ["roa"],
	"application/rsd+xml": ["rsd"],
	"application/rss+xml": ["rss"],
	"application/rtf": ["rtf"],
	"application/sbml+xml": ["sbml"],
	"application/scvp-cv-request": ["scq"],
	"application/scvp-cv-response": ["scs"],
	"application/scvp-vp-request": ["spq"],
	"application/scvp-vp-response": ["spp"],
	"application/sdp": ["sdp"],
	"application/senml+xml": ["senmlx"],
	"application/sensml+xml": ["sensmlx"],
	"application/set-payment-initiation": ["setpay"],
	"application/set-registration-initiation": ["setreg"],
	"application/shf+xml": ["shf"],
	"application/sieve": ["siv", "sieve"],
	"application/smil+xml": ["smi", "smil"],
	"application/sparql-query": ["rq"],
	"application/sparql-results+xml": ["srx"],
	"application/sql": ["sql"],
	"application/srgs": ["gram"],
	"application/srgs+xml": ["grxml"],
	"application/sru+xml": ["sru"],
	"application/ssdl+xml": ["ssdl"],
	"application/ssml+xml": ["ssml"],
	"application/swid+xml": ["swidtag"],
	"application/tei+xml": ["tei", "teicorpus"],
	"application/thraud+xml": ["tfi"],
	"application/timestamped-data": ["tsd"],
	"application/toml": ["toml"],
	"application/trig": ["trig"],
	"application/ttml+xml": ["ttml"],
	"application/ubjson": ["ubj"],
	"application/urc-ressheet+xml": ["rsheet"],
	"application/urc-targetdesc+xml": ["td"],
	"application/voicexml+xml": ["vxml"],
	"application/wasm": ["wasm"],
	"application/watcherinfo+xml": ["wif"],
	"application/widget": ["wgt"],
	"application/winhlp": ["hlp"],
	"application/wsdl+xml": ["wsdl"],
	"application/wspolicy+xml": ["wspolicy"],
	"application/xaml+xml": ["xaml"],
	"application/xcap-att+xml": ["xav"],
	"application/xcap-caps+xml": ["xca"],
	"application/xcap-diff+xml": ["xdf"],
	"application/xcap-el+xml": ["xel"],
	"application/xcap-ns+xml": ["xns"],
	"application/xenc+xml": ["xenc"],
	"application/xfdf": ["xfdf"],
	"application/xhtml+xml": ["xhtml", "xht"],
	"application/xliff+xml": ["xlf"],
	"application/xml": [
		"xml",
		"xsl",
		"xsd",
		"rng"
	],
	"application/xml-dtd": ["dtd"],
	"application/xop+xml": ["xop"],
	"application/xproc+xml": ["xpl"],
	"application/xslt+xml": ["*xsl", "xslt"],
	"application/xspf+xml": ["xspf"],
	"application/xv+xml": [
		"mxml",
		"xhvml",
		"xvml",
		"xvm"
	],
	"application/yang": ["yang"],
	"application/yin+xml": ["yin"],
	"application/zip": ["zip"],
	"application/zip+dotlottie": ["lottie"],
	"audio/3gpp": ["*3gpp"],
	"audio/aac": ["adts", "aac"],
	"audio/adpcm": ["adp"],
	"audio/amr": ["amr"],
	"audio/basic": ["au", "snd"],
	"audio/midi": [
		"mid",
		"midi",
		"kar",
		"rmi"
	],
	"audio/mobile-xmf": ["mxmf"],
	"audio/mp3": ["*mp3"],
	"audio/mp4": [
		"m4a",
		"mp4a",
		"m4b"
	],
	"audio/mpeg": [
		"mpga",
		"mp2",
		"mp2a",
		"mp3",
		"m2a",
		"m3a"
	],
	"audio/ogg": [
		"oga",
		"ogg",
		"spx",
		"opus"
	],
	"audio/s3m": ["s3m"],
	"audio/silk": ["sil"],
	"audio/wav": ["wav"],
	"audio/wave": ["*wav"],
	"audio/webm": ["weba"],
	"audio/xm": ["xm"],
	"font/collection": ["ttc"],
	"font/otf": ["otf"],
	"font/ttf": ["ttf"],
	"font/woff": ["woff"],
	"font/woff2": ["woff2"],
	"image/aces": ["exr"],
	"image/apng": ["apng"],
	"image/avci": ["avci"],
	"image/avcs": ["avcs"],
	"image/avif": ["avif"],
	"image/bmp": ["bmp", "dib"],
	"image/cgm": ["cgm"],
	"image/dicom-rle": ["drle"],
	"image/dpx": ["dpx"],
	"image/emf": ["emf"],
	"image/fits": ["fits"],
	"image/g3fax": ["g3"],
	"image/gif": ["gif"],
	"image/heic": ["heic"],
	"image/heic-sequence": ["heics"],
	"image/heif": ["heif"],
	"image/heif-sequence": ["heifs"],
	"image/hej2k": ["hej2"],
	"image/ief": ["ief"],
	"image/jaii": ["jaii"],
	"image/jais": ["jais"],
	"image/jls": ["jls"],
	"image/jp2": ["jp2", "jpg2"],
	"image/jpeg": [
		"jpg",
		"jpeg",
		"jpe"
	],
	"image/jph": ["jph"],
	"image/jphc": ["jhc"],
	"image/jpm": ["jpm", "jpgm"],
	"image/jpx": ["jpx", "jpf"],
	"image/jxl": ["jxl"],
	"image/jxr": ["jxr"],
	"image/jxra": ["jxra"],
	"image/jxrs": ["jxrs"],
	"image/jxs": ["jxs"],
	"image/jxsc": ["jxsc"],
	"image/jxsi": ["jxsi"],
	"image/jxss": ["jxss"],
	"image/ktx": ["ktx"],
	"image/ktx2": ["ktx2"],
	"image/pjpeg": ["jfif"],
	"image/png": ["png"],
	"image/sgi": ["sgi"],
	"image/svg+xml": ["svg", "svgz"],
	"image/t38": ["t38"],
	"image/tiff": ["tif", "tiff"],
	"image/tiff-fx": ["tfx"],
	"image/webp": ["webp"],
	"image/wmf": ["wmf"],
	"message/disposition-notification": ["disposition-notification"],
	"message/global": ["u8msg"],
	"message/global-delivery-status": ["u8dsn"],
	"message/global-disposition-notification": ["u8mdn"],
	"message/global-headers": ["u8hdr"],
	"message/rfc822": [
		"eml",
		"mime",
		"mht",
		"mhtml"
	],
	"model/3mf": ["3mf"],
	"model/gltf+json": ["gltf"],
	"model/gltf-binary": ["glb"],
	"model/iges": ["igs", "iges"],
	"model/jt": ["jt"],
	"model/mesh": [
		"msh",
		"mesh",
		"silo"
	],
	"model/mtl": ["mtl"],
	"model/obj": ["obj"],
	"model/prc": ["prc"],
	"model/step": [
		"step",
		"stp",
		"stpnc",
		"p21",
		"210"
	],
	"model/step+xml": ["stpx"],
	"model/step+zip": ["stpz"],
	"model/step-xml+zip": ["stpxz"],
	"model/stl": ["stl"],
	"model/u3d": ["u3d"],
	"model/vrml": ["wrl", "vrml"],
	"model/x3d+binary": ["*x3db", "x3dbz"],
	"model/x3d+fastinfoset": ["x3db"],
	"model/x3d+vrml": ["*x3dv", "x3dvz"],
	"model/x3d+xml": ["x3d", "x3dz"],
	"model/x3d-vrml": ["x3dv"],
	"text/cache-manifest": ["appcache", "manifest"],
	"text/calendar": ["ics", "ifb"],
	"text/coffeescript": ["coffee", "litcoffee"],
	"text/css": ["css"],
	"text/csv": ["csv"],
	"text/html": [
		"html",
		"htm",
		"shtml"
	],
	"text/jade": ["jade"],
	"text/javascript": ["js", "mjs"],
	"text/jsx": ["jsx"],
	"text/less": ["less"],
	"text/markdown": ["md", "markdown"],
	"text/mathml": ["mml"],
	"text/mdx": ["mdx"],
	"text/n3": ["n3"],
	"text/plain": [
		"txt",
		"text",
		"conf",
		"def",
		"list",
		"log",
		"in",
		"ini"
	],
	"text/richtext": ["rtx"],
	"text/rtf": ["*rtf"],
	"text/sgml": ["sgml", "sgm"],
	"text/shex": ["shex"],
	"text/slim": ["slim", "slm"],
	"text/spdx": ["spdx"],
	"text/stylus": ["stylus", "styl"],
	"text/tab-separated-values": ["tsv"],
	"text/troff": [
		"t",
		"tr",
		"roff",
		"man",
		"me",
		"ms"
	],
	"text/turtle": ["ttl"],
	"text/uri-list": [
		"uri",
		"uris",
		"urls"
	],
	"text/vcard": ["vcard"],
	"text/vtt": ["vtt"],
	"text/wgsl": ["wgsl"],
	"text/xml": ["*xml"],
	"text/yaml": ["yaml", "yml"],
	"video/3gpp": ["3gp", "3gpp"],
	"video/3gpp2": ["3g2"],
	"video/h261": ["h261"],
	"video/h263": ["h263"],
	"video/h264": ["h264"],
	"video/iso.segment": ["m4s"],
	"video/jpeg": ["jpgv"],
	"video/jpm": ["*jpm", "*jpgm"],
	"video/mj2": ["mj2", "mjp2"],
	"video/mp2t": [
		"ts",
		"m2t",
		"m2ts",
		"mts"
	],
	"video/mp4": [
		"mp4",
		"mp4v",
		"mpg4"
	],
	"video/mpeg": [
		"mpeg",
		"mpg",
		"mpe",
		"m1v",
		"m2v"
	],
	"video/ogg": ["ogv"],
	"video/quicktime": ["qt", "mov"],
	"video/webm": ["webm"]
};
Object.freeze(types$2);
//#endregion
//#region ../../node_modules/.pnpm/mime@4.1.1/node_modules/mime/dist/src/Mime.js
var __classPrivateFieldGet = function(receiver, state, kind, f) {
	if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
	if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
	return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _Mime_extensionToType, _Mime_typeToExtension, _Mime_typeToExtensions;
var Mime = class {
	constructor(...args) {
		_Mime_extensionToType.set(this, /* @__PURE__ */ new Map());
		_Mime_typeToExtension.set(this, /* @__PURE__ */ new Map());
		_Mime_typeToExtensions.set(this, /* @__PURE__ */ new Map());
		for (const arg of args) this.define(arg);
	}
	define(typeMap, force = false) {
		for (let [type, extensions] of Object.entries(typeMap)) {
			type = type.toLowerCase();
			extensions = extensions.map((ext) => ext.toLowerCase());
			if (!__classPrivateFieldGet(this, _Mime_typeToExtensions, "f").has(type)) __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").set(type, /* @__PURE__ */ new Set());
			const allExtensions = __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").get(type);
			let first = true;
			for (let extension of extensions) {
				const starred = extension.startsWith("*");
				extension = starred ? extension.slice(1) : extension;
				allExtensions?.add(extension);
				if (first) __classPrivateFieldGet(this, _Mime_typeToExtension, "f").set(type, extension);
				first = false;
				if (starred) continue;
				const currentType = __classPrivateFieldGet(this, _Mime_extensionToType, "f").get(extension);
				if (currentType && currentType != type && !force) throw new Error(`"${type} -> ${extension}" conflicts with "${currentType} -> ${extension}". Pass \`force=true\` to override this definition.`);
				__classPrivateFieldGet(this, _Mime_extensionToType, "f").set(extension, type);
			}
		}
		return this;
	}
	getType(path) {
		if (typeof path !== "string") return null;
		const last = path.replace(/^.*[/\\]/s, "").toLowerCase();
		const ext = last.replace(/^.*\./s, "").toLowerCase();
		const hasPath = last.length < path.length;
		if (!(ext.length < last.length - 1) && hasPath) return null;
		return __classPrivateFieldGet(this, _Mime_extensionToType, "f").get(ext) ?? null;
	}
	getExtension(type) {
		if (typeof type !== "string") return null;
		type = type?.split?.(";")[0];
		return (type && __classPrivateFieldGet(this, _Mime_typeToExtension, "f").get(type.trim().toLowerCase())) ?? null;
	}
	getAllExtensions(type) {
		if (typeof type !== "string") return null;
		type = type.split(";")[0].trim().toLowerCase();
		return __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").get(type) ?? null;
	}
	_freeze() {
		this.define = () => {
			throw new Error("define() not allowed for built-in Mime objects. See https://github.com/broofa/mime/blob/main/README.md#custom-mime-instances");
		};
		Object.freeze(this);
		for (const extensions of __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").values()) Object.freeze(extensions);
		return this;
	}
	_getTestState() {
		return {
			types: __classPrivateFieldGet(this, _Mime_extensionToType, "f"),
			extensions: __classPrivateFieldGet(this, _Mime_typeToExtension, "f")
		};
	}
};
_Mime_extensionToType = /* @__PURE__ */ new WeakMap(), _Mime_typeToExtension = /* @__PURE__ */ new WeakMap(), _Mime_typeToExtensions = /* @__PURE__ */ new WeakMap();
//#endregion
//#region ../../node_modules/.pnpm/mime@4.1.1/node_modules/mime/dist/src/index.js
var src_default = new Mime(types$2, types$3)._freeze();
//#endregion
//#region ../../packages/util/file-drag/lib/index.js
/**
* Resolve one platform-safe export filename. Explicit suffix wins; compatible suffixes survive.
* A known conflicting suffix is replaced from MIME; unknown MIME never rejects a supplied name.
* @param request - caller name, declared content type, and optional explicit suffix.
* @returns cleaned filename, with MIME-derived suffix only when needed.
*/
function resolveDragFileName(request) {
	const { name = "file", mediaType, outputExtension } = request;
	let clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/gu, "_").replace(/^[. ]+|[. ]+$/gu, "") || "file";
	const dot = clean.lastIndexOf(".");
	const suffix = dot < 0 ? "" : clean.slice(dot + 1);
	const declared = mediaType.replace(/;.*$/su, "").trim().toLowerCase();
	const preferred = src_default.getExtension(declared);
	const explicit = outputExtension?.replace(/^\./u, "").replace(/[^a-z\d_-]/giu, "");
	const compatible = src_default.getAllExtensions(declared)?.has(suffix.toLowerCase()) === true;
	const extension = explicit || (suffix === "" || preferred !== null && !compatible ? preferred : suffix);
	if (extension) clean = `${dot < 0 ? clean : clean.slice(0, dot)}.${extension}`;
	if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(clean)) clean = `_${clean}`;
	const finalDot = clean.lastIndexOf(".");
	const tail = finalDot < 0 ? "" : clean.slice(finalDot);
	const encoder = new TextEncoder();
	const truncate = (value, bytes) => {
		let result = "";
		for (const character of value) {
			const length = encoder.encode(character).length;
			if (length > bytes) break;
			result += character;
			bytes -= length;
		}
		return result;
	};
	const extensionTail = truncate(tail, 32);
	return `${truncate(finalDot < 0 ? clean : clean.slice(0, finalDot), 255 - encoder.encode(extensionTail).length)}${extensionTail}`;
}
//#endregion
//#region lib/types/ipc.js
/** IPC channel names kept private to the desktop application bundle. */
const DESKTOP_IPC = {
	fileSave: "dsh-desktop:file-save",
	clipboardImageRead: "dsh-desktop:clipboard-image-read",
	shortcutsInput: "dsh-desktop:shortcuts-input",
	shortcutsCloseWindow: "dsh-desktop:shortcuts-close-window",
	shortcutsGet: "dsh-desktop:shortcuts-get",
	shortcutsEdit: "dsh-desktop:shortcuts-edit",
	shortcutsChanged: "dsh-desktop:shortcuts-changed",
	shortcutsRecording: "dsh-desktop:shortcuts-recording",
	boot: "dsh-desktop:boot",
	enterWorkspace: "dsh-desktop:enter-workspace",
	onboardingActive: "dsh-desktop:onboarding-active",
	onboardingApiKey: "dsh-desktop:onboarding-api-key",
	bootFailed: "dsh-desktop:boot-failed",
	browserAcquire: "dsh-desktop:browser-acquire",
	browserRelease: "dsh-desktop:browser-release",
	browserOpenRequested: "dsh-desktop:browser-open-requested",
	directoryPick: "dsh-desktop:directory-pick",
	fileDragPrepare: "dsh-desktop:file-drag-prepare",
	fileDragCancel: "dsh-desktop:file-drag-cancel",
	fileDragStart: "dsh-desktop:file-drag-start",
	fileDragRelease: "dsh-desktop:file-drag-release",
	deviceInfo: "dsh-desktop:device-info",
	localeBootstrap: "dsh-desktop:locale-bootstrap",
	localeChanged: "dsh-desktop:locale-changed",
	updatesChannelGet: "dsh-desktop:updates-channel-get",
	updatesChannelSet: "dsh-desktop:updates-channel-set",
	updatesChannelChanged: "dsh-desktop:updates-channel-changed",
	updatesStatus: "dsh-desktop:updates-status",
	updatesOpen: "dsh-desktop:updates-open",
	updatesPresentation: "dsh-desktop:updates-presentation",
	nativeThemeSet: "dsh-desktop:native-theme-set",
	windowFullscreen: "dsh-desktop:window-fullscreen",
	windowsAppearance: "dsh-desktop:windows-appearance",
	windowsMenu: "dsh-desktop:windows-menu"
};
/** Scheme of Desktop-owned application documents. */
const SCHEME = "dsh-app";
/**
* Reject IPC outside the allowed Desktop document origins.
* @param event - IPC caller whose frame URL supplies the origin.
* @param hostnames - Desktop document hosts allowed for this operation.
*/
function assertDesktopSender(event, hostnames) {
	const senderFrame = event.senderFrame;
	if (senderFrame === null) throw new Error("dsh desktop: rejected IPC without a sender frame");
	const url = new URL(senderFrame.url);
	if (url.protocol !== `dsh-app:` || !hostnames.includes(url.hostname)) throw new Error("dsh desktop: rejected IPC from an unowned renderer");
}
//#endregion
//#region lib/types/duration-env.js
/** Millisecond settings read from the Desktop process environment. */
/**
* Read a duration that `setTimeout` accepts without clamping.
* @param env - Desktop process environment.
* @param name - Variable to read; the validation error names it.
* @param fallback - Value used when the variable is unset.
* @returns Integer milliseconds from 1000 through 2147483647.
*/
function resolveDurationMs(env, name, fallback) {
	const value = Number(env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value < 1e3 || value > 2147483647) throw new Error(`${name} must be an integer from 1000 through 2147483647`);
	return value;
}
//#endregion
//#region lib/types/file-actions.js
/** Trusted-window Chromium downloads and clipboard fallback reads. */
/** @param value - untrusted IPC input. @returns captured URL and destination policy. */
function saveRequest(value) {
	if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string" || "name" in value && typeof value.name !== "string" || "mediaType" in value && typeof value.mediaType !== "string" || !("mode" in value) || value.mode !== "download" && value.mode !== "saveAs") throw new Error("Invalid file save request");
	const url = new URL(value.url);
	if (![
		"https:",
		"http:",
		"blob:",
		"data:"
	].includes(url.protocol) || url.username || url.password) throw new Error("Unsupported file source");
	return {
		url,
		mode: value.mode,
		..."name" in value ? { name: value.name } : {},
		..."mediaType" in value ? { mediaType: value.mediaType } : {}
	};
}
/**
* Install trusted-window original-file operations.
* @param assertOwner - rejects shell pages, subframes, and unowned windows.
* @param hostUrl - current application Host excluded from image reads.
*/
function installFileActions(assertOwner, hostUrl = () => void 0) {
	const timeoutMs = resolveDurationMs(process.env, "DSH_DESKTOP_IMAGE_READ_TIMEOUT_MS", 3e4);
	const maxBytes = Number(process.env.DSH_DESKTOP_IMAGE_READ_MAX_BYTES ?? 64 * 1024 * 1024);
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("DSH_DESKTOP_IMAGE_READ_MAX_BYTES must be a positive integer");
	const pending = /* @__PURE__ */ new Map();
	session.defaultSession.on("will-download", (_event, item, contents) => {
		const url = item.getURLChain()[0];
		if (url === void 0 || !new URL(url).hash.startsWith("#dsh-download=")) return;
		const entry = pending.get(url);
		if (entry === void 0 || entry.owner.webContents !== contents) {
			item.cancel();
			return;
		}
		entry.started();
		entry.item = item;
		let reserved;
		try {
			assertOwner(entry.event);
			const name = resolveDragFileName({
				name: entry.request.name ?? item.getFilename(),
				mediaType: item.getMimeType() || entry.request.mediaType || ""
			});
			let destination = join(app.getPath("downloads"), name);
			if (entry.request.mode === "saveAs") item.setSaveDialogOptions({
				defaultPath: destination,
				properties: ["showOverwriteConfirmation", "createDirectory"]
			});
			else {
				const extension = extname(destination);
				const stem = destination.slice(0, destination.length - extension.length);
				for (let index = 0;; index++) {
					destination = index === 0 ? `${stem}${extension}` : `${stem} (${index})${extension}`;
					try {
						closeSync(openSync(destination, "wx"));
						break;
					} catch (error) {
						if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") continue;
						throw error;
					}
				}
				reserved = destination;
				item.setSavePath(destination);
			}
			item.once("done", (_event, state) => {
				try {
					if (state !== "completed") {
						if (reserved !== void 0) rmSync(reserved, { force: true });
						entry.finish(state === "cancelled" ? { status: "cancelled" } : /* @__PURE__ */ new Error("File download interrupted"));
						return;
					}
					if (!pending.has(url)) return;
					assertOwner(entry.event);
					entry.finish({
						status: "saved",
						path: item.getSavePath()
					});
				} catch (error) {
					entry.finish(error instanceof Error ? error : /* @__PURE__ */ new Error("File download unavailable"));
				}
			});
		} catch (error) {
			item.cancel();
			try {
				if (reserved !== void 0) rmSync(reserved, { force: true });
			} catch (cleanupError) {
				entry.finish(new AggregateError([error, cleanupError], "File download failed and its partial file could not be removed"));
				return;
			}
			entry.finish(error instanceof Error ? error : /* @__PURE__ */ new Error("File download unavailable"));
		}
	});
	const downloadTimeoutMs = resolveDurationMs(process.env, "DSH_DESKTOP_FILE_DOWNLOAD_TIMEOUT_MS", 3e5);
	ipcMain.handle(DESKTOP_IPC.fileSave, (event, value) => {
		const owner = assertOwner(event);
		const request = saveRequest(value);
		request.url.hash = `dsh-download=${randomUUID()}`;
		const url = request.url.href;
		return new Promise((resolve, reject) => {
			const contents = owner.webContents;
			const finish = (result) => {
				if (!pending.delete(url)) return;
				clearTimeout(timer);
				owner.removeListener("closed", cancel);
				contents.removeListener("did-start-navigation", navigate);
				if (result instanceof Error) reject(result);
				else resolve(result);
			};
			const cancel = () => {
				const item = pending.get(url)?.item;
				finish({ status: "cancelled" });
				item?.cancel();
			};
			const navigate = (_event, _url, inPlace, mainFrame) => {
				if (mainFrame && !inPlace) cancel();
			};
			const timer = setTimeout(() => {
				const item = pending.get(url)?.item;
				finish(/* @__PURE__ */ new Error("File download timed out"));
				item?.cancel();
			}, downloadTimeoutMs);
			pending.set(url, {
				event,
				owner,
				request,
				finish,
				started: () => {
					clearTimeout(timer);
				}
			});
			owner.once("closed", cancel);
			contents.on("did-start-navigation", navigate);
			try {
				contents.downloadURL(url);
			} catch (error) {
				finish(error instanceof Error ? error : /* @__PURE__ */ new Error("File download unavailable"));
			}
		});
	});
	ipcMain.handle(DESKTOP_IPC.clipboardImageRead, async (event, value) => {
		const owner = assertOwner(event);
		if (typeof value !== "string") throw new Error("Invalid image URL");
		const checkedUrl = (value) => {
			const url = new URL(value);
			const host = hostUrl();
			const application = host === void 0 ? void 0 : new URL(host);
			if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || application !== void 0 && url.port === application.port && (url.hostname === application.hostname || [
				"localhost",
				"127.0.0.1",
				"[::1]"
			].includes(url.hostname))) throw new Error("Invalid image URL");
			return url;
		};
		let url = checkedUrl(value);
		const contents = owner.webContents;
		const lifetime = new AbortController();
		const abort = () => {
			lifetime.abort();
		};
		owner.once("closed", abort);
		const navigate = (_event, _url, inPlace, mainFrame) => {
			if (mainFrame && !inPlace) abort();
		};
		contents.on("did-start-navigation", navigate);
		try {
			const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]);
			let response;
			for (let redirects = 0;; redirects++) {
				response = await fetch(url, {
					signal,
					redirect: "manual",
					credentials: "omit",
					referrerPolicy: "no-referrer"
				});
				if (![
					301,
					302,
					303,
					307,
					308
				].includes(response.status)) break;
				await response.body?.cancel();
				const location = response.headers.get("location");
				if (redirects >= 20 || location === null) throw new Error("Invalid image redirect");
				url = checkedUrl(new URL(location, url).href);
			}
			if (!response.ok) throw new Error("Original image unavailable");
			const reader = response.body?.getReader();
			if (reader === void 0) throw new Error("Original image unavailable");
			const chunks = [];
			let size = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.byteLength;
					if (size > maxBytes) throw new Error("Original image exceeds the download limit");
					chunks.push(chunk.value);
				}
			} finally {
				await reader.cancel();
				reader.releaseLock();
			}
			assertOwner(event);
			lifetime.signal.throwIfAborted();
			return {
				bytes: new Uint8Array(Buffer.concat(chunks)),
				mediaType: response.headers.get("content-type") ?? ""
			};
		} finally {
			owner.removeListener("closed", abort);
			contents.removeListener("did-start-navigation", navigate);
		}
	});
}
//#endregion
//#region ../../packages/util/atomic-write/lib/index.js
/**
* Zero-dependency atomic file replacement and writer coordination.
* `writeFileAtomic` writes a random-suffix sibling with exclusive create and
* the caller's permission bits, then renames it over the target, so readers
* observe either the old or the new complete content and a replaced file ends
* up with exactly the stated mode. `withFileLock` serializes cross-process
* writers of one file through a `wx`-created `<file>.lock` sibling, so a
* read-modify-write cycle can never resurrect a state another writer just
* replaced; readers stay lock-free because the rename commit is atomic. A lock
* whose recorded holder process no longer exists is taken over.
* @module @deepseek-ai/dsh-atomic-write
*/
const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set([
	"EACCES",
	"EBUSY",
	"EPERM"
]);
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20;
const WINDOWS_RENAME_RETRY_MAX_MS = 200;
const WINDOWS_RENAME_RETRY_LIMIT = 8;
/** Whether Windows reported temporary interference with an atomic replacement. */
function isTransientWindowsRenameError(error) {
	if (process.platform !== "win32") return false;
	return WINDOWS_TRANSIENT_RENAME_ERRORS.has(error?.code ?? "");
}
/** Replace the target after bounded retries for transient Windows interference. */
async function renameAtomicTemp(temp, filename) {
	let delay = WINDOWS_RENAME_RETRY_INITIAL_MS;
	for (let retries = 0;; retries += 1) {
		try {
			await rename(temp, filename);
			return;
		} catch (error) {
			if (!isTransientWindowsRenameError(error)) throw error;
			if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, delay));
		delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS);
	}
}
/**
* Replace `filename` with `content` in one atomic step, creating parent
* directories. The content is first written to a random-suffix sibling opened
* with exclusive create (`wx`): the open refuses to follow a symlink planted
* at the temp path, and the fresh inode carries `options.mode` through the
* rename, so replacing a wider-permission file narrows it without a chmod
* race. The rename also replaces a symlinked target itself instead of writing
* through to its referent, and the same-directory sibling keeps the rename on
* one filesystem. Windows replacement retries transient `EACCES`, `EBUSY`,
* and `EPERM` failures for a bounded interval while the complete temp file
* remains the rename source. On any remaining failure the temp file is
* removed and the failure rethrown. Crash durability (fsync) is out of scope.
* @param filename - final path receiving the content.
* @param content - complete next file content.
* @param options - permission bits for the replacement inode.
*/
async function writeFileAtomic(filename, content, options) {
	await mkdir(dirname(filename), {
		recursive: true,
		...options.dirMode === void 0 ? {} : { mode: options.dirMode }
	});
	const temp = `${filename}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(temp, content, {
			mode: options.mode,
			flag: "wx"
		});
		await renameAtomicTemp(temp, filename);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}
/** Whether an exclusive create found an existing lock. */
async function isLockContention(error, lockPath) {
	const code = error?.code;
	if (code === "EEXIST") return true;
	if (code !== "EPERM") return false;
	try {
		await lstat(lockPath);
		return true;
	} catch {
		return false;
	}
}
/** Whether the holder a `<pid>\n` record names is proven gone: a signal probe finds no such process. */
function holderExited(record) {
	if (!/^\d+\n$/.test(record)) return false;
	const pid = Number(record.trim());
	if (pid === 0 || pid > 2147483647) return false;
	if (pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error.code === "ESRCH";
	}
}
/** The lock file's content, or undefined when it cannot be read. */
async function readLockRecord(lockPath) {
	try {
		return await readFile$1(lockPath, "utf8");
	} catch (error) {
		return;
	}
}
/**
* Remove the lock when its recorded holder exited. Contenders that read the
* same record serialize on a claim file named after it. Under the claim, the
* claimant re-reads the lock and probes its PID again, and removes it only
* when it still holds that record and that PID is still gone: the record's
* holder can no longer release it, and no other contender can remove it
* without the claim, so a removal never deletes a lock another contender
* acquired after the dead holder's, including one whose holder reused the PID.
* @returns Whether this call removed the dead holder's lock.
*/
async function takeOverExitedLock(lockPath) {
	const record = await readLockRecord(lockPath);
	if (record === void 0 || !holderExited(record)) return false;
	const claim = `${lockPath}.takeover-${createHash("sha256").update(record).digest("hex").slice(0, 16)}`;
	try {
		await writeFile(claim, `${process.pid}\n`, {
			mode: 384,
			flag: "wx"
		});
	} catch (error) {
		const code = error.code;
		if (code === "EEXIST" || code === "EPERM") return false;
		throw error;
	}
	try {
		if (await readLockRecord(lockPath) !== record || !holderExited(record)) return false;
		try {
			await rm(lockPath, { force: true });
		} catch (error) {
			return false;
		}
		return true;
	} finally {
		await rm(claim, { force: true }).catch((error) => {});
	}
}
/**
* Retry cadence for a contended lock. These stay robustness invariants of the
* cross-process write protocol rather than deployment tunables: they govern how
* often a contender asks, which no caller has a reason to vary.
*/
const LOCK_RETRY_INITIAL_MS = 20;
const LOCK_RETRY_MAX_MS = 200;
/**
* How long a contender waits when the caller states no limit — sized for the
* render-and-rename cycle every call site had when this package was written.
* Expiry fails the contender rather than guessing whether the existing lock
* still has an owner. How long is *worth* waiting is a property of the
* operation the lock holder runs, which is why {@link FileLockOptions.waitMs}
* exists; the value here is the floor for an operation that does file work
* alone.
*/
const DEFAULT_LOCK_WAIT_MS = 2e3;
/**
* Hold the cross-process writer lock for `filename` around one operation. The
* lock is a `wx`-created sibling (`<filename>.lock`); paired with the
* rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
* only writers contend. `EEXIST` is contention directly; an `EPERM` is
* contention only when a fresh `lstat` confirms the lock path exists, covering
* Windows exclusive-create behavior. Windows retries one unconfirmed EPERM
* because the holder can release before the probe; a repeated unconfirmed
* permission error is rethrown. The lock records its holder's PID. A contender
* removes the lock and retries at once when no process with that PID exists
* (`ESRCH`); any other lock, including one whose holder exists under another
* user (`EPERM`) or whose record is incomplete, is waited for. Contention backs
* off exponentially and times out after the deadline. A holder whose PID a
* live process reused keeps its lock until an operator removes it. Takeover
* proves only that the recorded process exited: an operation that starts other
* writers must stop them with it or leave its successor a way to find them.
* PIDs are compared on the contender's host, so writers on other hosts or in
* other PID namespaces sharing the file are unsupported and could both hold
* the lock. The parent directory must exist.
* @param filename - the file whose writers this lock serializes.
* @param operation - the read-render-commit cycle to run while holding the lock.
* @param options - acquisition options; omitted waits {@link DEFAULT_LOCK_WAIT_MS}.
* @returns the operation's result; the lock releases on both outcomes.
*/
async function withFileLock(filename, operation, options) {
	const lockPath = `${filename}.lock`;
	const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS);
	let delay = LOCK_RETRY_INITIAL_MS;
	let retriedUnconfirmedPermissionError = false;
	for (;;) {
		options?.signal?.throwIfAborted();
		try {
			await writeFile(lockPath, `${process.pid}\n`, {
				mode: 384,
				flag: "wx"
			});
			break;
		} catch (error) {
			if (!await isLockContention(error, lockPath)) {
				if (process.platform !== "win32" || error?.code !== "EPERM" || retriedUnconfirmedPermissionError) throw error;
				retriedUnconfirmedPermissionError = true;
			} else if (await takeOverExitedLock(lockPath)) continue;
		}
		if (Date.now() >= deadline) throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`);
		await setTimeout$1(delay, void 0, { signal: options?.signal });
		delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
	}
	try {
		options?.signal?.throwIfAborted();
		return await operation();
	} finally {
		await rm(lockPath, { force: true });
	}
}
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function joinValues(array, separator = "|") {
	return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
var Cached = class {
	constructor(getter) {
		this._getter = getter;
		this._value = void 0;
	}
	get value() {
		const getter = this._getter;
		if (getter !== void 0) {
			this._value = getter();
			this._getter = void 0;
		}
		return this._value;
	}
};
function cached(getter) {
	return new Cached(getter);
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const ratio = val / step;
	const roundedRatio = Math.round(ratio);
	const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
	if (Math.abs(ratio - roundedRatio) < tolerance) return 0;
	return ratio - roundedRatio;
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
/**
* Whichever object a def's `shape` currently answers from: the one the caller passed until the first read, the frozen copy after it.
*
* Its keys and descriptors read without invoking anything, which is what lets a discriminated union check its discriminator, and the cycle walk read a shape, without resolving a getter that references the schema being constructed. A def that answers `shape` from an accessor of its own has none.
*/
function rawShape(def) {
	const desc = Object.getOwnPropertyDescriptor(def, "shape");
	return desc?.get ? desc.get.raw : desc?.value;
}
function sourceShape(schema) {
	return rawShape(schema._zod.def) ?? schema._zod.def.shape;
}
function deferProp(target, key, getter) {
	Object.defineProperty(target, key, {
		get() {
			const value = getter();
			assignProp(this, key, value);
			return value;
		},
		enumerable: true,
		configurable: true
	});
}
function putProp(target, key, value) {
	if (key in target) assignProp(target, key, value);
	else target[key] = value;
}
/**
* Copies `keys` of `source`'s shape onto `target`, each value passed through `wrap`.
*
* A key the source has resolved is copied through now, so the derived shape states it outright and nothing has to resolve it to learn what it holds. A key the source still defers stays deferred, and reads back through the source's own `shape`, so it resolves once and both shapes get that one schema.
*/
function mirrorShape(target, source, keys, wrap) {
	const raw = sourceShape(source);
	for (const key of keys) {
		const desc = Object.getOwnPropertyDescriptor(raw, key);
		if (!desc.enumerable) continue;
		if (desc.get) deferProp(target, key, () => {
			const value = source._zod.def.shape[key];
			return wrap ? wrap(value, key) : value;
		});
		else putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
	}
}
function mirrorProps(target, source) {
	for (const key of Reflect.ownKeys(source)) {
		const desc = Object.getOwnPropertyDescriptor(source, key);
		if (!desc.enumerable) continue;
		if (desc.get) deferProp(target, key, () => source[key]);
		else putProp(target, key, desc.value);
	}
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) Object.assign(mergedDescriptors, Object.getOwnPropertyDescriptors(def));
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
const allowsEval = /* @__PURE__*/ cached(() => {
	if (globalConfig.jitless) return false;
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	if (o instanceof Map) return new Map(o);
	if (o instanceof Set) return new Set(o);
	return o;
}
const propertyKeyTypes = /* @__PURE__*/ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function stringifyPrimitive(value) {
	if (typeof value === "bigint") return value.toString() + "n";
	if (typeof value === "string") return `"${value}"`;
	return `${value}`;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin !== void 0 && shape[k]._zod.optout === "optional";
	});
}
const NUMBER_FORMAT_RANGES = /*@__PURE__*/ (() => ({
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}))();
const BIGINT_FORMAT_RANGES = {
	int64: [/* @__PURE__*/ BigInt("-9223372036854775808"), /* @__PURE__*/ BigInt("9223372036854775807")],
	uint64: [/* @__PURE__*/ BigInt(0), /* @__PURE__*/ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	const newShape = {};
	mirrorShape(newShape, schema, maskedKeys(schema, mask));
	return clone(schema, mergeDefs(currDef, {
		shape: newShape,
		checks: []
	}));
}
function maskedKeys(schema, mask) {
	const raw = sourceShape(schema);
	const keys = [];
	for (const key of Reflect.ownKeys(mask)) {
		if (!Object.getOwnPropertyDescriptor(raw, key)?.enumerable) throw new Error(`Unrecognized key: "${String(key)}"`);
		if (mask[key]) keys.push(key);
	}
	return keys;
}
function omit$1(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	const omitted = new Set(maskedKeys(schema, mask));
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)).filter((key) => !omitted.has(key)));
	return clone(schema, mergeDefs(currDef, {
		shape: newShape,
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = sourceShape(schema);
		for (const key of Reflect.ownKeys(shape)) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function extended(schema, shape) {
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)));
	mirrorProps(newShape, shape);
	return newShape;
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function merge$2(a, b) {
	if (!b?._zod?.def) throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
	if (a._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
	const newShape = {};
	mirrorShape(newShape, a, Reflect.ownKeys(sourceShape(a)));
	mirrorShape(newShape, b, Reflect.ownKeys(sourceShape(b)));
	return clone(a, mergeDefs(a._zod.def, {
		shape: newShape,
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: b._zod.def.checks ?? []
	}));
}
function partial(Class, schema, mask, name = "partial") {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
	const selected = mask ? new Set(maskedKeys(schema, mask)) : void 0;
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), Class && ((value, key) => selected && !selected.has(key) ? value : new Class({
		type: "optional",
		innerType: value
	})));
	return clone(schema, mergeDefs(schema._zod.def, {
		shape: newShape,
		checks: []
	}));
}
function required(Class, schema, mask) {
	const selected = mask ? new Set(maskedKeys(schema, mask)) : void 0;
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), (value, key) => selected && !selected.has(key) ? value : new Class({
		type: "nonoptional",
		innerType: value
	}));
	return clone(schema, mergeDefs(schema._zod.def, { shape: newShape }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function explicitlyAborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue === false) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
/** The leading size checks of `defChecks` that set an upper bound, each paired with it. */
function sizeCaps(defChecks) {
	const caps = [];
	for (const ch of defChecks ?? []) {
		const d = ch._zod.def;
		if (!/_(length|size)$|_equals$/.test(d.check)) break;
		const max = d.maximum ?? d.length ?? d.size;
		if (max >= 0) caps.push([max, ch]);
	}
	return caps;
}
function attachSchema(issues, start, inst) {
	var _a;
	for (let i = start; i < issues.length; i++) (_a = issues[i]).schema ?? (_a.schema = inst);
}
function finalizeIssue(iss, ctx, config) {
	var _a;
	const traits = iss.inst?._zod?.traits;
	if (traits?.has("$ZodType")) if (traits.has("$ZodCheck")) (_a = iss).schema ?? (_a.schema = iss.inst);
	else iss.schema = iss.inst;
	const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : void 0;
	const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	const full = {};
	for (const k of Object.keys(iss)) {
		if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__") continue;
		full[k] = iss[k];
	}
	full.path ?? (full.path = []);
	full.message = message;
	if (ctx?.reportInput) full.input = iss.input;
	return full;
}
const highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
	const units = str.length;
	if (!highSurrogate.test(str)) return units;
	let count = units;
	for (let i = 0; i < units - 1; i++) if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
		count--;
		i++;
	}
	return count;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function parsedType(data) {
	const t = typeof data;
	switch (t) {
		case "number": return Number.isNaN(data) ? "nan" : "number";
		case "object": {
			if (data === null) return "null";
			if (Array.isArray(data)) return "array";
			const obj = data;
			if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) return obj.constructor.name;
		}
	}
	return t;
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}
/**
* Installs a trait's members on its prototype. Each value builds that member for the instance on first read; the built value shadows the accessor as an own property, so a detached `const { parse } = schema` keeps working.
*
* Call this from a `proto` initializer, which runs once per prototype — never per instance.
*/
function members$1(proto, table) {
	for (const key in table) {
		const desc = Object.getOwnPropertyDescriptor(table, key);
		if (desc.get) Object.defineProperty(proto, key, {
			...desc,
			enumerable: false
		});
		else defineBound(proto, key, desc.value);
	}
}
/** Shadows a prototype member with an own value, so a getter that builds from the instance runs once. */
function own(inst, key, value, enumerable = true) {
	Object.defineProperty(inst, key, {
		configurable: true,
		writable: true,
		enumerable,
		value
	});
	return value;
}
/** Like {@link own}, for a member that was never an own data property and has to stay out of `Object.keys`. */
function hide(inst, key, value) {
	return own(inst, key, value, false);
}
/** Adds members a table derives from the instance: each builds on first read and shadows as own data, and assignment shadows the same way, as when these were own properties. */
function derived(computes, table) {
	for (const key in computes) {
		const compute = computes[key];
		Object.defineProperty(table, key, {
			configurable: true,
			enumerable: true,
			get() {
				return own(this, key, compute(this));
			},
			set(value) {
				own(this, key, value);
			}
		});
	}
	return table;
}
function defineBound(proto, key, fn) {
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			return this == null ? fn : own(this, key, fn.bind(this));
		},
		set(value) {
			own(this, key, value);
		}
	});
}
/** Returns the prototype to install on, or `undefined` if this group is already installed on it. */
function claim(inst, sentinel) {
	const proto = Object.getPrototypeOf(inst);
	return sentinel in proto ? void 0 : proto;
}
let installing;
let broke = false;
const breaker = {
	configurable: true,
	get() {
		broke = true;
	}
};
/**
* Installs a lazily-derived internal on the `_zod` prototype of `inst`'s
* constructor, computed from the internals object itself and cached there on
* first read. One accessor per constructor rather than one per instance.
*/
function defineLazyInternal(inst, key, compute) {
	const proto = Object.getPrototypeOf(inst._zod);
	if (key in proto && installing !== inst._zod) {
		installing = void 0;
		return;
	}
	installing = inst._zod;
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			Object.defineProperty(this, key, breaker);
			const outer = broke;
			broke = false;
			try {
				const value = compute(this);
				if (broke) delete this[key];
				else Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					value
				});
				broke = broke || outer;
				return value;
			} catch (err) {
				delete this[key];
				broke = broke || outer;
				throw err;
			}
		},
		set(value) {
			Object.defineProperty(this, key, {
				configurable: true,
				writable: true,
				value
			});
		}
	});
}
/**
* Installs `key` on `inst`'s prototype, computed by `make` on first read and cached there as an own
* data property. One accessor per constructor rather than one per instance, because an own accessor
* puts every instance after the first into v8 dictionary mode. The key doubles as the sentinel.
*/
function installLazyProp(inst, key, make, enumerable) {
	const proto = claim(inst, key);
	if (!proto) return;
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			const desc = {
				configurable: true,
				writable: true,
				enumerable,
				value: void 0
			};
			Object.defineProperty(this, key, desc);
			desc.value = make(this);
			Object.defineProperty(this, key, desc);
			return desc.value;
		},
		set(value) {
			Object.defineProperty(this, key, {
				configurable: true,
				writable: true,
				enumerable,
				value
			});
		}
	});
}
/** Marks the thunk `_catch` synthesises for a constant catch value. `Function.length` cannot tell that thunk from a user callback — rest and defaulted parameters both report arity 0 — and a user callback reads `ctx.error`, whose issues only finalize correctly against the caller's per-parse error map. Provenance can say what arity cannot. A plain string key rather than `Symbol.for`, whose call at module scope no bundler can prove pure — the same shape that anchored `urlCanParse` into every build. */
const CONSTANT_CATCH = "~constantCatch";
/** Wraps a constant catch value in a thunk tagged with {@link CONSTANT_CATCH}. */
function constantCatch(value) {
	const fn = () => value;
	fn[CONSTANT_CATCH] = true;
	return fn;
}
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/core.js
var _a$1;
const _zodDesc = {
	value: void 0,
	enumerable: false
};
let _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
	const E = _E;
	if (E) {
		const saved = E.stackTraceLimit;
		if (typeof saved === "number") {
			try {
				E.stackTraceLimit = 0;
			} catch {
				_E = null;
				return new Definition();
			}
			try {
				return new Definition();
			} finally {
				E.stackTraceLimit = saved;
			}
		}
	}
	return new Definition();
}
function $constructor(name, initializer, proto, params) {
	const zodProto = {};
	function Internals(def) {
		this.def = def;
		this.constr = _;
		this.traits = /* @__PURE__ */ new Set();
	}
	Internals.prototype = zodProto;
	const protoMembers = proto;
	const initialized = protoMembers && /* @__PURE__ */ new WeakSet();
	function init(inst, def) {
		if (!inst._zod) {
			_zodDesc.value = new Internals(def);
			try {
				Object.defineProperty(inst, "_zod", _zodDesc);
			} finally {
				_zodDesc.value = void 0;
			}
		} else if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		if (initialized) {
			const own = Object.getPrototypeOf(inst);
			const ctorProto = inst._zod.constr.prototype;
			let up = own;
			while (up && up !== ctorProto) up = Object.getPrototypeOf(up);
			const target = up ?? own;
			if (!initialized.has(target)) {
				initialized.add(target);
				members$1(target, protoMembers);
			}
		}
		const proto = _.prototype;
		for (const k in proto) {
			if (!Object.prototype.hasOwnProperty.call(proto, k)) continue;
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		const inst = params?.Parent ? newError(Definition) : this;
		init(inst, def);
		const deferred = inst._zod.deferred;
		if (deferred) {
			for (const fn of deferred) fn();
			inst._zod.deferred = void 0;
		}
		const pp = globalThis.__zod_globalConfig?.postProcessor;
		if (pp) pp(inst);
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
(_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
const globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/errors.js
function _getMessage() {
	const internals = this._zod;
	internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
	return internals.message;
}
function _setMessage(value) {
	this._zod.message = value;
}
const _messageDesc = {
	get: _getMessage,
	set: _setMessage,
	enumerable: true,
	configurable: true
};
const _issuesDesc = {
	value: void 0,
	enumerable: false
};
const _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
const initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	_issuesDesc.value = def;
	Object.defineProperty(inst, "issues", _issuesDesc);
	_issuesDesc.value = void 0;
	Object.defineProperty(inst, "message", _messageDesc);
	const proto = Object.getPrototypeOf(inst);
	if (!_installedToString.has(proto)) {
		_installedToString.add(proto);
		Object.defineProperty(proto, "toString", {
			configurable: true,
			enumerable: false,
			get() {
				const value = () => this.message;
				Object.defineProperty(this, "toString", {
					value,
					configurable: true,
					writable: true
				});
				return value;
			},
			set(value) {
				Object.defineProperty(this, "toString", {
					value,
					configurable: true,
					writable: true
				});
			}
		});
	}
};
const $ZodError = $constructor("$ZodError", initializer$1);
$constructor("$ZodError", initializer$1, void 0, { Parent: Error });
/** Get-or-create `obj[key]` as an own data property. A path segment naming an inherited member
* ("toString", "constructor") would otherwise read through to the prototype, and assigning
* "__proto__" would hit the setter instead of creating a key. */
function node(obj, key, make) {
	if (!Object.prototype.hasOwnProperty.call(obj, key)) if (key === "__proto__") Object.defineProperty(obj, key, {
		value: make(),
		writable: true,
		enumerable: true,
		configurable: true
	});
	else obj[key] = make();
	return obj[key];
}
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
	else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error, path = []) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else if (issue.code === "invalid_element") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else {
			const fullpath = [...path, ...issue.path];
			if (fullpath.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < fullpath.length) {
					const el = fullpath[i];
					const terminal = i === fullpath.length - 1;
					if (el === "_errors") {
						if (terminal) curr._errors.push(mapper(issue));
						i++;
						continue;
					}
					if (!Object.prototype.hasOwnProperty.call(curr, el)) Object.defineProperty(curr, el, {
						value: { _errors: [] },
						enumerable: true,
						writable: true,
						configurable: true
					});
					const node = curr[el];
					if (terminal) node._errors.push(mapper(issue));
					curr = node;
					i++;
				}
			}
		}
	};
	processError(error);
	return fieldErrors;
}
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
	return {
		callee: params?.callee ?? callee,
		Err: params?.Err
	};
}
const _parse = (_Err) => {
	const fn = (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: false
		} : { async: false };
		const result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) throw new $ZodAsyncError();
		if (result.issues.length) {
			const e = new ((_params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, _params?.callee ?? fn);
			throw e;
		}
		return result.value;
	};
	return fn;
};
const _parseAsync = (_Err) => {
	const fn = async (schema, value, _ctx, params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: true
		} : { async: true };
		let result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) result = await result;
		if (result.issues.length) {
			const e = new ((params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, params?.callee ?? fn);
			throw e;
		}
		return result.value;
	};
	return fn;
};
const _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? failure(_Err, result.issues, ctx) : {
		success: true,
		data: result.value
	};
};
function failure(Err, issues, ctx) {
	let error;
	return {
		success: false,
		get error() {
			if (!error) {
				error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
				issues = void 0;
				ctx = void 0;
			}
			return error;
		},
		set error(e) {
			error = e;
			issues = void 0;
			ctx = void 0;
		}
	};
}
const _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? failure(_Err, result.issues, ctx) : {
		success: true,
		data: result.value
	};
};
const COMPILE_INVALID = /* @__PURE__ */ Symbol.for("zod.compile.invalid");
const COMPILE_FALLBACK = /* @__PURE__ */ Symbol.for("zod.compile.fallback");
const validate = ((schema, value, _ctx) => {
	const validator = schema._zod.bag.validator;
	if (validator !== void 0) {
		if (validator(value) !== COMPILE_INVALID) return true;
		if (validator.definite === true && _ctx === void 0) return false;
	}
	return validateFallback(schema, value, _ctx);
});
function validateFallback(schema, value, _ctx) {
	const ctx = _ctx ? {
		..._ctx,
		async: false,
		abortEarly: true
	} : {
		async: false,
		abortEarly: true
	};
	const fallbackRun = schema._zod.bag.fallbackRun;
	let result;
	if (fallbackRun) {
		ctx[COMPILE_FALLBACK] = true;
		result = fallbackRun({
			value,
			issues: []
		}, ctx);
	} else result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length === 0;
}
const validateAsync$1 = async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true,
		abortEarly: true
	} : {
		async: true,
		abortEarly: true
	};
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length === 0;
};
const _encode = (_Err) => {
	const parse = _parse(_Err);
	const fn = (schema, value, _ctx, _params) => {
		return parse(schema, value, _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" }, finalizeParams(fn, _params));
	};
	return fn;
};
const _decode = (_Err) => {
	const parse = _parse(_Err);
	const fn = (schema, value, _ctx, _params) => {
		return parse(schema, value, _ctx, finalizeParams(fn, _params));
	};
	return fn;
};
const _encodeAsync = (_Err) => {
	const parseAsync = _parseAsync(_Err);
	const fn = async (schema, value, _ctx, _params) => {
		return await parseAsync(schema, value, _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" }, finalizeParams(fn, _params));
	};
	return fn;
};
const _decodeAsync = (_Err) => {
	const parseAsync = _parseAsync(_Err);
	const fn = async (schema, value, _ctx, _params) => {
		return await parseAsync(schema, value, _ctx, finalizeParams(fn, _params));
	};
	return fn;
};
const _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
const _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
const _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
const _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/regexes.js
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const cuid = /^[cC][0-9a-z]{6,}$/;
const cuid2 = /^[0-9a-z]+$/;
const ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
const xid = /^[0-9a-vA-V]{20}$/;
const ksuid = /^[A-Za-z0-9]{27}$/;
const nanoid = /^[a-zA-Z0-9_-]{21}$/;
function nanoidOfLength(length) {
	return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
const duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
const guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
const uuid$1 = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
const email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const _emoji$1 = `^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
const cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
const cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
const base64url = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;
const httpProtocol = /^https?$/;
const e164 = /^\+[1-9]\d{6,14}$/;
const dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
/** Anchors a pattern source. The interpolation lives here rather than at the call site because
* esbuild will not drop a `@__PURE__` call whose own argument interpolates a variable, but it
* will drop `anchor(dateSource)`. Keeping it inline pinned `date` into every bundle. */
function anchor(source) {
	return new RegExp(`^${source}$`);
}
const date = /*@__PURE__*/ anchor(dateSource);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime$1(args) {
	const opts = ["Z"];
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const qualified = `${timeSource({
		precision: args.precision,
		seconds: true
	})}(?:${opts.join("|")})`;
	const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
const anyString = /^[\s\S]{0,}$/;
const number$1 = /^-?\d+(?:\.\d+)?$/;
const boolean$1 = /^(?:true|false)$/i;
const lowercase = /^[^A-Z]*$/;
const uppercase = /^[^a-z]*$/;
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/checks.js
const $ZodCheck = /*@__PURE__*/ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
/** Default `when` for length-based checks: run only on non-nullish values with a `length`. */
const _whenHasLength = (payload) => {
	const val = payload.value;
	return !nullish(val) && val.length !== void 0;
};
const numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
const $ZodCheckLessThan = /*@__PURE__*/ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin: numericOriginMap[typeof payload.value] ?? origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckGreaterThan = /*@__PURE__*/ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin: numericOriginMap[typeof payload.value] ?? origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMultipleOf = /*@__PURE__*/ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? def.value !== BigInt(0) && payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckNumberFormat = /*@__PURE__*/ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMaxLength = /*@__PURE__*/ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		if ((typeof input === "string" && units > def.maximum ? codePointLength(input) : units) <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMinLength = /*@__PURE__*/ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		if ((typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units) >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLengthEquals = /*@__PURE__*/ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		const length = typeof input === "string" && units >= def.length && units <= def.length * 2 ? codePointLength(input) : units;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStringFormat = /*@__PURE__*/ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
const $ZodCheckRegex = /*@__PURE__*/ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLowerCase = /*@__PURE__*/ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckUpperCase = /*@__PURE__*/ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckIncludes = /*@__PURE__*/ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	def.pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position},}${escapedRegex}` : escapedRegex);
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStartsWith = /*@__PURE__*/ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckEndsWith = /*@__PURE__*/ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckOverwrite = /*@__PURE__*/ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = [], closed = {}) {
		this.content = [];
		this.indent = 0;
		this.args = args;
		this.closed = closed;
	}
	indented(fn) {
		this.indent += 1;
		try {
			fn(this);
		} finally {
			this.indent -= 1;
		}
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const content = this?.content ?? [``];
		return new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {\n${content.join("\n")}\n};`)(...Object.values(this.closed));
	}
};
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/versions.js
const version = {
	major: 4,
	minor: 6,
	patch: 6
};
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/schemas.js
const $ZodType = /*@__PURE__*/ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const defChecks = inst._zod.def.checks;
	const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			if (payload.memo) return payload;
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (explicitlyAborted(payload)) continue;
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					attachSchema(payload.issues, currLen, inst);
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					attachSchema(payload.issues, currLen, inst);
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
}, {
	get "~standard"() {
		return hide(this, "~standard", standardProps(this));
	},
	set "~standard"(value) {
		own(this, "~standard", value);
	}
});
/** The Standard Schema surface for `inst`. Shared so wrappers can extend it without forcing it. */
const toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
async function validateAsync(inst, value) {
	const ctx = { async: true };
	return toStandardResult(await inst._zod.run({
		value,
		issues: []
	}, ctx), ctx);
}
function standardProps(inst) {
	return {
		validate: (value) => {
			const ctx = { async: false };
			try {
				const r = inst._zod.run({
					value,
					issues: []
				}, ctx);
				if (!(r instanceof Promise)) return toStandardResult(r, ctx);
			} catch (_) {}
			return validateAsync(inst, value);
		},
		vendor: "zod",
		version: 1
	};
}
const $ZodString = /*@__PURE__*/ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = def.pattern ?? anyString;
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
const $ZodStringFormat = /*@__PURE__*/ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
const $ZodGUID = /*@__PURE__*/ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
const $ZodUUID = /*@__PURE__*/ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid$1(v));
	} else def.pattern ?? (def.pattern = uuid$1());
	$ZodStringFormat.init(inst, def);
});
const $ZodEmail = /*@__PURE__*/ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
function canParseURL(input) {
	try {
		if (typeof URL !== "undefined" && typeof URL.canParse === "function") return URL.canParse(input);
		new URL(input);
		return true;
	} catch {
		return false;
	}
}
function validateURL(trimmed, def) {
	if (!("normalize" in def) && !("hostname" in def) && !("protocol" in def)) return canParseURL(trimmed) || 2;
	return parseURLObject(trimmed, def);
}
/** Parses a URL while preserving the non-normalizing HTTP guard. */
function parseURLObject(trimmed, def) {
	if (!def.normalize && def.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) return 1;
	try {
		if (typeof URL !== "undefined") {
			const URLStatic = URL;
			if (typeof URLStatic.parse === "function") return URLStatic.parse(trimmed) ?? 2;
		}
		return new URL(trimmed);
	} catch {
		return 2;
	}
}
const asciiTabOrNewline = /[\t\n\r]/g;
/** The URL parser deletes every ASCII tab, LF and CR from its input before it parses, so `new URL("https://exa\nmple.com")` reports on `example.com`. Applying the same deletion to the returned value closes the half of that divergence which can move the host; the parser's other rewrite, stripping C0 controls at the edges, cannot. */
function stripTabAndNewline(value) {
	return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
	hostname.lastIndex = 0;
	return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
	protocol.lastIndex = 0;
	return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
const $ZodURL = /*@__PURE__*/ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			const url = validateURL(trimmed, def);
			if (url === 1) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid URL format",
					input: payload.value,
					inst,
					continue: !def.abort
				});
				return;
			}
			if (url === 2) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					input: payload.value,
					inst,
					continue: !def.abort
				});
				return;
			}
			if (url === true) {
				payload.value = stripTabAndNewline(trimmed);
				return;
			}
			if (def.hostname && !urlHostnameOk(url, def.hostname)) payload.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid hostname",
				pattern: def.hostname.source,
				input: payload.value,
				inst,
				continue: !def.abort
			});
			if (def.protocol && !urlProtocolOk(url, def.protocol)) payload.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid protocol",
				pattern: def.protocol.source,
				input: payload.value,
				inst,
				continue: !def.abort
			});
			payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed);
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodEmoji = /*@__PURE__*/ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
const $ZodNanoID = /*@__PURE__*/ $constructor("$ZodNanoID", (inst, def) => {
	if (def.length !== void 0 && (!Number.isInteger(def.length) || def.length < 1)) throw new Error(`Invalid nanoid length: ${def.length}`);
	def.pattern ?? (def.pattern = def.length === void 0 ? nanoid : nanoidOfLength(def.length));
	$ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const $ZodCUID = /*@__PURE__*/ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodCUID2 = /*@__PURE__*/ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
const $ZodULID = /*@__PURE__*/ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
const $ZodXID = /*@__PURE__*/ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
const $ZodKSUID = /*@__PURE__*/ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodISODateTime = /*@__PURE__*/ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODate = /*@__PURE__*/ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date);
	$ZodStringFormat.init(inst, def);
});
const $ZodISOTime = /*@__PURE__*/ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODuration = /*@__PURE__*/ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration);
	$ZodStringFormat.init(inst, def);
});
const $ZodIPv4 = /*@__PURE__*/ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
});
/** An IPv6 address is written with hex digits, colons and dots, and nothing else. The guard is what makes the check below an IPv6 check: `new URL("http://[...]")` parses an authority, not an address, so `@` and `\` re-delimit it and `"::@1\\"` validates against the host `0.0.0.1`. The URL parser also deletes ASCII tab, LF and CR rather than failing, which is how `"::1\n"` validated as `::1`. */
const ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
function isValidIPv6(value) {
	if (!ipv6Alphabet.test(value)) return false;
	return canParseURL(`http://[${value}]`);
}
const $ZodIPv6 = /*@__PURE__*/ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (!isValidIPv6(payload.value)) payload.issues.push({
			code: "invalid_format",
			format: "ipv6",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCIDRv4 = /*@__PURE__*/ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
function isValidCIDRv6(value) {
	const parts = value.split("/");
	if (parts.length !== 2) return false;
	const [address, prefix] = parts;
	if (!prefix) return false;
	const prefixNum = Number(prefix);
	if (`${prefixNum}` !== prefix) return false;
	if (prefixNum < 0 || prefixNum > 128) return false;
	return isValidIPv6(address);
}
const $ZodCIDRv6 = /*@__PURE__*/ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (!isValidCIDRv6(payload.value)) payload.issues.push({
			code: "invalid_format",
			format: "cidrv6",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (/\s/.test(data)) return false;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
const base64Charset = /^[0-9a-zA-Z+/]*={0,2}$/;
const $ZodBase64 = /*@__PURE__*/ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64Charset);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const base64urlCharset = /^[A-Za-z0-9_-]*$/;
function isValidBase64URL(data) {
	if (!base64urlCharset.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
const $ZodBase64URL = /*@__PURE__*/ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64urlCharset);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodE164 = /*@__PURE__*/ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
const $ZodJWT = /*@__PURE__*/ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodNumber = /*@__PURE__*/ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = number$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
const $ZodNumberFormat = /*@__PURE__*/ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
const $ZodBoolean = /*@__PURE__*/ $constructor("$ZodBoolean", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = boolean$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Boolean(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "boolean") return payload;
		payload.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
const $ZodUnknown = /*@__PURE__*/ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
const $ZodNever = /*@__PURE__*/ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function capSize(inst, size) {
	const caps = sizeCaps(inst._zod.def.checks);
	if (!caps.length) return;
	const cap = Math.min(...caps.map((c) => c[0]));
	const parse = inst._zod.parse;
	inst._zod.parse = (payload, ctx) => {
		const n = size(payload.value);
		if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
			for (const [max, ch] of sizeCaps(inst._zod.def.checks)) if (n > max && ch._zod.def.when(payload)) {
				const start = payload.issues.length;
				ch._zod.check(payload);
				payload.issues[start].continue = false;
				attachSchema(payload.issues, start, inst);
				return payload;
			}
		}
		return parse(payload, ctx);
	};
}
const arraySize = (input) => Array.isArray(input) ? input.length : -1;
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
const $ZodArray = /*@__PURE__*/ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
		const proms = [];
		const abortEarly = ctx?.abortEarly;
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else {
				handleArrayResult(result, payload, i);
				if (abortEarly && result.issues.length !== 0 && aborted(result)) break;
			}
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
	capSize(inst, arraySize);
});
function handlePropertyResult(result, final, key, input, optin, optout) {
	const isPresent = key in input;
	const isOptionalOut = optout === "optional";
	if (!isPresent && isOptionalOut && optin === "optional") return;
	if (result.issues.length) {
		if (optin !== void 0 && isOptionalOut && !isPresent) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (!isPresent && optin === void 0) {
		if (!result.issues.length) final.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: void 0,
			path: [key]
		});
		return;
	}
	if (result.value === void 0) {
		if (isPresent || optin === "defaulted" && !isOptionalOut) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
const NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	const ownSymbols = Object.getOwnPropertySymbols(def.shape);
	const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
	const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
	for (const k of allKeys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		allKeys,
		symbolKeys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst, abortEarly) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const optin = _catchall.optin;
	const optout = _catchall.optout;
	let seen = 0;
	for (const key in input) {
		if (abortEarly && payload.issues.length !== seen) {
			if (aborted(payload, seen)) break;
			seen = payload.issues.length;
		}
		if (keySet.has(key)) continue;
		if (key === "__proto__") {
			if (t === "never") unrecognized.push(key);
			continue;
		}
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
		else handlePropertyResult(r, payload, key, input, optin, optout);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst,
		continue: true
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
const $ZodObject = /*@__PURE__*/ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	const desc = Object.getOwnPropertyDescriptor(def, "shape");
	const sh = desc?.get ? desc.get.raw : def.shape ?? {};
	if (sh) {
		const get = () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			get.raw = newSh;
			return newSh;
		};
		get.raw = sh;
		Object.defineProperty(def, "shape", { get });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazyInternal(inst, "propValues", (zod) => {
		const shape = zod.def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				if (!Object.prototype.hasOwnProperty.call(propValues, key)) assignProp(propValues, key, /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
				if (field.optin !== void 0) propValues[key].add(void 0);
			}
		}
		return propValues;
	});
	const isObject$1 = isObject;
	const catchall = def.catchall;
	let value;
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
		const proms = [];
		const shape = value.shape;
		const abortEarly = ctx?.abortEarly;
		let seen = payload.issues.length;
		for (const key of value.allKeys) {
			if (abortEarly && payload.issues.length !== seen) {
				if (aborted(payload, seen)) break;
				seen = payload.issues.length;
			}
			if (key === "__proto__") continue;
			const el = shape[key];
			const optin = el._zod.optin;
			const optout = el._zod.optout;
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
			else handlePropertyResult(r, payload, key, input, optin, optout);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
	};
});
const $ZodObjectJIT = /*@__PURE__*/ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const memo = globalConfig.memoizer;
	const generateFastpass = (shape) => {
		const normalized = _normalized.value;
		const syms = normalized.symbolKeys;
		const doc = new Doc(["payload", "ctx"], {
			shape,
			inst,
			memo,
			syms
		});
		const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		const prefixStr = (id, k) => `
          let ${id}_ab = false;
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
            if (iss.continue !== true) ${id}_ab = true;
          }
          if (${id}_ab && ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }`;
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.allKeys) ids[key] = `key_${counter++}`;
		doc.write(memo ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
		for (const key of normalized.allKeys) {
			if (key === "__proto__") continue;
			const id = ids[key];
			const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
			const isPresent = `${k} in input`;
			const schema = shape[key];
			const optin = schema?._zod?.optin;
			const isOptionalIn = optin !== void 0;
			const isOptionalOut = schema?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(k)};`);
			if (isOptionalIn && isOptionalOut) {
				const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
				doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
			} else if (!isOptionalIn) doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
          if (ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
			else {
				doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
      `);
				if (optin === "defaulted") doc.write(`newResult[${k}] = ${id}.value;`);
				else doc.write(`
        if (${id}.value !== undefined || ${isPresent}) {
          newResult[${k}] = ${id}.value;
        }
      `);
			}
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		return doc.compile();
	};
	let fastpass;
	const isObject$2 = isObject;
	const jit = !globalConfig.jitless;
	const fastEnabled = jit && allowsEval.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst, ctx?.abortEarly === true);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
const $ZodUnion = /*@__PURE__*/ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== void 0) ? "optional" : void 0);
	defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazyInternal(inst, "values", (zod) => {
		if (zod.def.options.every((o) => o._zod.values)) return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazyInternal(inst, "pattern", (zod) => {
		if (zod.def.options.every((o) => o._zod.pattern)) {
			const patterns = zod.def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const first = def.options.length === 1 ? def.options[0]._zod.run : null;
	inst._zod.parse = (payload, ctx) => {
		if (first) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
function discriminatorMap(def) {
	const map = /* @__PURE__ */ new Map();
	for (const option of def.options) {
		const values = option._zod.propValues?.[def.discriminator];
		if (!values || values.size === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
		for (const value of values) if (map.has(value)) {
			if (value !== void 0) throw new Error(`Duplicate discriminator value "${String(value)}"`);
			map.set(value, null);
		} else map.set(value, option);
	}
	return map;
}
const $ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
	def.inclusive = false;
	$ZodUnion.init(inst, def);
	const _super = inst._zod.parse;
	defineLazyInternal(inst, "propValues", (zod) => {
		const propValues = {};
		let undefinedCount = 0;
		for (const option of zod.def.options) {
			const pv = option._zod.propValues;
			if (!pv || Object.keys(pv).length === 0) throw new Error(`Invalid discriminated union option at index "${zod.def.options.indexOf(option)}"`);
			if (pv[zod.def.discriminator]?.has(void 0)) undefinedCount++;
			for (const [k, v] of Object.entries(pv)) {
				if (!Object.prototype.hasOwnProperty.call(propValues, k)) assignProp(propValues, k, /* @__PURE__ */ new Set());
				for (const val of v) propValues[k].add(val);
			}
		}
		if (!zod.def.unionFallback && undefinedCount > 1) propValues[zod.def.discriminator]?.delete(void 0);
		return propValues;
	});
	def.options.forEach((option, i) => {
		const propShape = rawShape(option._zod.def);
		if (propShape && !Object.prototype.hasOwnProperty.call(propShape, def.discriminator)) throw new Error(`Invalid discriminated union option at index "${i}"`);
	});
	const disc = cached(() => discriminatorMap(def));
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isObject(input)) {
			payload.issues.push({
				code: "invalid_type",
				expected: "object",
				input,
				inst
			});
			return payload;
		}
		const value = input?.[def.discriminator];
		const opt = disc.value.get(value);
		if (opt && (value !== void 0 || ctx.direction !== "backward")) return opt._zod.run(payload, ctx);
		if (def.unionFallback || ctx.direction === "backward") return _super(payload, ctx);
		payload.issues.push({
			code: "invalid_union",
			errors: [],
			note: "No matching discriminator",
			discriminator: def.discriminator,
			options: Array.from(disc.value.keys()).filter((value) => disc.value.get(value) !== null),
			input,
			path: [def.discriminator],
			inst
		});
		return payload;
	};
});
const $ZodIntersection = /*@__PURE__*/ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		if (Object.prototype.hasOwnProperty.call(newObj, "__proto__")) delete newObj.__proto__;
		for (const key of sharedKeys) {
			if (key === "__proto__") continue;
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	const keyIssues = /* @__PURE__ */ new Map();
	const collect = (iss, side) => {
		let keys;
		if (iss.code === "unrecognized_keys" && !iss.path?.length) {
			unrecIssue ?? (unrecIssue = iss);
			keys = iss.keys;
		} else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
			const k = String(iss.path[0]);
			if (!keyIssues.has(k)) keyIssues.set(k, iss);
			keys = [k];
		} else return false;
		for (const k of keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k)[side] = true;
		}
		return true;
	};
	for (const iss of left.issues) if (!collect(iss, "l")) result.issues.push(iss);
	for (const iss of right.issues) if (!collect(iss, "r")) result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length) {
		const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
		if (aggregated.length) result.issues.push({
			...unrecIssue,
			keys: aggregated
		});
		for (const k of bothKeys) if (!aggregated.includes(k) && keyIssues.has(k)) result.issues.push(keyIssues.get(k));
	}
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) {
		if (aborted(result)) return result;
		throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	}
	result.value = merged.data;
	return result;
}
const $ZodEnum = /*@__PURE__*/ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	defineLazyInternal(inst, "pattern", (zod) => {
		const patternValues = getEnumValues(zod.def.entries).filter((k) => propertyKeyTypes.has(typeof k));
		return new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
	});
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodLiteral = /*@__PURE__*/ $constructor("$ZodLiteral", (inst, def) => {
	$ZodType.init(inst, def);
	const values = new Set(def.values);
	inst._zod.values = values;
	defineLazyInternal(inst, "pattern", (zod) => {
		const vals = zod.def.values;
		return new RegExp(vals.length ? `^(${vals.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$` : "^[^\\s\\S]$");
	});
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (values.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values: def.values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodTransform = /*@__PURE__*/ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	globalConfig.memoizer?.guard(inst);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		return payload;
	};
});
function handleOptionalResult(payload, result) {
	payload.value = result.issues.length ? void 0 : result.value;
	return payload;
}
const $ZodOptional = /*@__PURE__*/ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
	inst._zod.optout = "optional";
	defineLazyInternal(inst, "values", (zod) => {
		const values = zod.def.innerType._zod.values;
		return values ? new Set([...values, void 0]) : void 0;
	});
	defineLazyInternal(inst, "pattern", (zod) => {
		const pattern = zod.def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === void 0) {
			if (def.innerType._zod.optin !== "defaulted") return payload;
			const result = def.innerType._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) return result.then((result) => handleOptionalResult(payload, result));
			return handleOptionalResult(payload, result);
		}
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodExactOptional = /*@__PURE__*/ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNullable = /*@__PURE__*/ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
	defineLazyInternal(inst, "pattern", (zod) => {
		const pattern = zod.def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazyInternal(inst, "values", (zod) => {
		return zod.def.innerType._zod.values ? new Set([...zod.def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodDefault = /*@__PURE__*/ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "defaulted";
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
const $ZodPrefault = /*@__PURE__*/ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "defaulted";
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNonOptional = /*@__PURE__*/ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => {
		const v = zod.def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
function handleCatchResult(payload, result, def, ctx) {
	if (!result.issues.length) {
		payload.value = result.value;
		if (result.memo) payload.memo = true;
		return payload;
	}
	payload.value = def.catchValue({
		...result,
		value: payload.value,
		error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
		input: payload.value
	});
	return payload;
}
const $ZodCatch = /*@__PURE__*/ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run({
			value: payload.value,
			issues: []
		}, ctx);
		if (result instanceof Promise) return result.then((result) => handleCatchResult(payload, result, def, ctx));
		return handleCatchResult(payload, result, def, ctx);
	};
});
const $ZodPipe = /*@__PURE__*/ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
	defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
	defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues
	}, ctx);
}
const $ZodReadonly = /*@__PURE__*/ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	if (!payload.memo) payload.value = Object.freeze(payload.value);
	return payload;
}
const $ZodCustom = /*@__PURE__*/ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/memoizer.js
var $ZodCyclicError = class extends Error {
	constructor() {
		super(`Cannot parse a reference cycle that closes through a transform`);
		this.name = "ZodCyclicError";
	}
};
/** Keyed off the context object every schema in one parse call already shares. */
const STATE = "~memo";
const NO_ISSUES = [];
function isRef(value) {
	return value !== null && typeof value === "object";
}
function cloneIssues(issues) {
	return issues.map((iss) => iss.path ? {
		...iss,
		path: iss.path.slice()
	} : { ...iss });
}
const recursive = /*@__PURE__*/ new WeakMap();
/** What the walk established, in order of certainty: ordered so the strongest answer among children wins. */
const NONE = 0;
const ASSUMED = 1;
const PROVEN = 2;
/** Whether this schema's subtree contains a cycle, so one parse can re-enter it. */
function isRecursive(inst, stack, resolve) {
	const cached = recursive.get(inst);
	if (cached !== void 0) return cached ? PROVEN : NONE;
	if (stack.has(inst)) return PROVEN;
	stack.add(inst);
	let result = NONE;
	const check = (child) => {
		if (result !== PROVEN && child?._zod) {
			const answer = isRecursive(child, stack, resolve);
			if (answer > result) result = answer;
		}
	};
	const shape = (sh, spread) => {
		let answer = NONE;
		for (const key of Reflect.ownKeys(sh)) {
			const desc = Object.getOwnPropertyDescriptor(sh, key);
			if (spread && !desc.enumerable) continue;
			const child = desc.get ? ASSUMED : desc.value?._zod ? isRecursive(desc.value, stack, resolve) : NONE;
			if (child > answer) answer = child;
		}
		return answer;
	};
	const merge = (answer) => {
		if (answer > result) result = answer;
	};
	const def = inst._zod.def;
	switch (def.type) {
		case "object": {
			const raw = rawShape(def);
			merge(raw ? shape(raw, true) : ASSUMED);
			check(def.catchall);
			break;
		}
		case "array":
			check(def.element);
			break;
		case "tuple":
			for (const el of def.items) check(el);
			check(def.rest);
			break;
		case "record":
		case "map":
			check(def.keyType);
			check(def.valueType);
			break;
		case "set":
			check(def.valueType);
			break;
		case "union":
			for (const el of def.options) check(el);
			break;
		case "intersection":
			check(def.left);
			check(def.right);
			break;
		case "optional":
		case "nullable":
		case "default":
		case "prefault":
		case "catch":
		case "readonly":
		case "nonoptional":
		case "promise":
		case "success":
			check(def.innerType);
			break;
		case "pipe":
			check(def.in);
			check(def.out);
			break;
		case "function":
			check(def.input);
			check(def.output);
			break;
		case "lazy": {
			const inner = def._cachedInner ?? (resolve ? inst._zod.innerType : void 0);
			merge(inner ? isRecursive(inner, stack, false) : ASSUMED);
			break;
		}
		case "template_literal":
		case "string":
		case "number":
		case "int":
		case "boolean":
		case "bigint":
		case "symbol":
		case "undefined":
		case "null":
		case "void":
		case "never":
		case "any":
		case "unknown":
		case "date":
		case "nan":
		case "enum":
		case "literal":
		case "file":
		case "transform":
		case "custom": break;
		default: for (const key in def) {
			const desc = Object.getOwnPropertyDescriptor(def, key);
			if (!desc || desc.get) continue;
			const value = desc.value;
			if (!value || typeof value !== "object") continue;
			if (value._zod) check(value);
			else if (Array.isArray(value)) for (const el of value) check(el);
		}
	}
	stack.delete(inst);
	return settle(inst, result);
}
/** An assumed answer must not outlive the resolution that settles it, so only a certain one is cached. */
function settle(inst, answer) {
	if (answer !== ASSUMED) recursive.set(inst, answer === PROVEN);
	return answer;
}
function bucketFor(state, inst) {
	let bucket = state.buckets.get(inst);
	if (!bucket) {
		bucket = /* @__PURE__ */ new WeakMap();
		state.buckets.set(inst, bucket);
	}
	return bucket;
}
let handoff;
const open$1 = [];
const memo = {
	alloc(_inst, payload, empty) {
		const bucket = handoff;
		if (!bucket) return empty;
		handoff = void 0;
		const entry = {
			value: empty,
			issues: null
		};
		bucket.set(payload.value, entry);
		open$1.push(entry);
		return empty;
	},
	guard(inst) {
		var _a;
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred.push(() => {
			const base = inst._zod.parse;
			const wrapped = (payload, ctx) => {
				if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value)) throw new $ZodCyclicError();
				return base(payload, ctx);
			};
			inst._zod.parse = wrapped;
			if (inst._zod.run === base) inst._zod.run = wrapped;
		});
	},
	attach(inst) {
		var _a;
		let isRecursiveInst;
		let rechecked = false;
		let lastCtx;
		let lastBucket;
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred.push(() => {
			const base = inst._zod.parse;
			const wrapped = (payload, ctx) => {
				if (isRecursiveInst === void 0) {
					const walked = isRecursive(inst, /* @__PURE__ */ new Set(), false);
					if (walked === NONE) {
						inst._zod.parse = base;
						if (inst._zod.run === wrapped) inst._zod.run = base;
						return base(payload, ctx);
					}
					if (walked === PROVEN || rechecked) isRecursiveInst = true;
					else rechecked = true;
				}
				const input = payload.value;
				if (!isRef(input)) return base(payload, ctx);
				let state = ctx[STATE];
				if (!state) {
					state = {
						buckets: /* @__PURE__ */ new WeakMap(),
						backEdges: void 0
					};
					ctx[STATE] = state;
				}
				let bucket;
				if (lastCtx === ctx) bucket = lastBucket;
				else {
					bucket = bucketFor(state, inst);
					lastCtx = ctx;
					lastBucket = bucket;
				}
				const hit = bucket.get(input);
				if (hit) {
					payload.value = hit.value;
					if (hit.issues) {
						if (hit.issues.length) payload.issues.push(...cloneIssues(hit.issues));
					} else {
						payload.memo = true;
						state.backEdges ?? (state.backEdges = /* @__PURE__ */ new WeakSet());
						state.backEdges.add(hit.value);
					}
					return payload;
				}
				handoff = bucket;
				const depth = open$1.length;
				const result = base(payload, ctx);
				handoff = void 0;
				const entry = open$1.length > depth ? open$1.pop() : void 0;
				if (result instanceof Promise) return result.then((r) => {
					if (entry) entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
					return r;
				});
				if (entry) entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
				return result;
			};
			inst._zod.parse = wrapped;
			if (inst._zod.run === base) inst._zod.run = wrapped;
		});
	}
};
/** The memoizer that gives containers cycle support. `zod` installs it by default; `zod/mini` opts in with `config({ memoizer: memoizer() })`. */
function memoizer() {
	return memo;
}
/** Whether this value is a node a back-edge resolved to before it finished. */
function isBackEdge(ctx, value) {
	const backEdges = ctx[STATE]?.backEdges;
	return backEdges !== void 0 && isRef(value) && backEdges.has(value);
}
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/locales/en.js
const error = () => {
	const Sizable = {
		string: {
			unit: "characters",
			verb: "to have"
		},
		file: {
			unit: "bytes",
			verb: "to have"
		},
		array: {
			unit: "items",
			verb: "to have"
		},
		set: {
			unit: "items",
			verb: "to have"
		},
		map: {
			unit: "entries",
			verb: "to have"
		}
	};
	function getSizing(origin) {
		return Sizable[origin] ?? null;
	}
	const FormatDictionary = {
		regex: "input",
		email: "email address",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO datetime",
		date: "ISO date",
		time: "ISO time",
		duration: "ISO duration",
		ipv4: "IPv4 address",
		ipv6: "IPv6 address",
		mac: "MAC address",
		cidrv4: "IPv4 range",
		cidrv6: "IPv6 range",
		base64: "base64-encoded string",
		base64url: "base64url-encoded string",
		json_string: "JSON string",
		e164: "E.164 number",
		currency_code: "currency code",
		credit_card: "credit card number",
		iban: "IBAN",
		jwt: "JWT",
		template_literal: "input"
	};
	const TypeDictionary = { nan: "NaN" };
	function getTypeName(type, input) {
		if (type === "number" && typeof input === "number" && !Number.isFinite(input)) return String(input);
		return TypeDictionary[type] ?? type;
	}
	return (issue) => {
		switch (issue.code) {
			case "invalid_type": return `Invalid input: expected ${getTypeName(issue.expected)}, received ${getTypeName(parsedType(issue.input), issue.input)}`;
			case "invalid_value":
				if (issue.values.length === 1) return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
				return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
			case "too_big": {
				const adj = issue.exact ? "exactly " : issue.inclusive ? "<=" : "<";
				const sizing = getSizing(issue.origin);
				if (sizing) return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
				return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
			}
			case "too_small": {
				const adj = issue.exact ? "exactly " : issue.inclusive ? ">=" : ">";
				const sizing = getSizing(issue.origin);
				if (sizing) return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
				return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
			}
			case "invalid_format": {
				const _issue = issue;
				if (_issue.format === "starts_with") return `Invalid string: must start with "${_issue.prefix}"`;
				if (_issue.format === "ends_with") return `Invalid string: must end with "${_issue.suffix}"`;
				if (_issue.format === "includes") return `Invalid string: must include "${_issue.includes}"`;
				if (_issue.format === "regex") return `Invalid string: must match pattern ${_issue.pattern}`;
				return `Invalid ${FormatDictionary[_issue.format] ?? issue.format}`;
			}
			case "not_multiple_of": return `Invalid number: must be a multiple of ${issue.divisor}`;
			case "unrecognized_keys": return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
			case "invalid_key": return `Invalid key in ${issue.origin}`;
			case "invalid_union":
				if (issue.options && Array.isArray(issue.options) && issue.options.length > 0) return `Invalid discriminator value. Expected ${issue.options.map((o) => `'${o}'`).join(" | ")}`;
				if (issue.inclusive === false) return "Invalid input: more than one option matched";
				return "Invalid input";
			case "invalid_element": return `Invalid value in ${issue.origin}`;
			default: return `Invalid input`;
		}
	};
};
function en_default() {
	return { localeError: error() };
}
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
const globalRegistry = globalThis.__zod_globalRegistry;
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
	if (def.checks) def.checks = [...def.checks];
	return def;
}
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
	return new Class(snapshotChecks({
		type: "string",
		...normalizeParams(params)
	}));
}
// @__NO_SIDE_EFFECTS__
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link _cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
// @__NO_SIDE_EFFECTS__
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
	return new Class(snapshotChecks({
		type: "number",
		checks: [],
		...normalizeParams(params)
	}));
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
	return new Class({
		type: "boolean",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn, params) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				if (!("input" in _issue)) _issue.input = payload.value;
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	}, params);
	return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
	for (const source of sources) for (const key of Reflect.ownKeys(source)) if (Object.prototype.propertyIsEnumerable.call(source, key)) assignProp(target, key, source[key]);
	return target;
}
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		sharedDefsExtractedFor: void 0,
		sharedEmitDoneFor: void 0,
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		intersections: [],
		deferred: [],
		external: params?.external ?? void 0
	};
}
/**
* Applies the `unrepresentable` setting at a site that has no JSON Schema equivalent. Throws
* `message` unless the setting (or the handler's return value) says otherwise. Returns `true` if a
* custom JSON Schema was written into `json`, in which case the caller must not write its own.
*/
function handleUnrepresentable(schema, ctx, json, params, message) {
	const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({
		zodSchema: schema,
		path: params.path,
		message
	}) : ctx.unrepresentable;
	if (result === "any") return false;
	if (result === void 0 || result === "throw") throw new Error(message);
	Object.assign(json, result);
	return true;
}
function processSchema(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	ctx.sharedDefsExtractedFor = void 0;
	ctx.sharedEmitDoneFor = void 0;
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			processSchema(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) assignProps(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && "_prefault" in result.schema) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function encodeJSONPointerSegment(segment) {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external) return;
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}`
			};
		}
		const uriPrefix = `#`;
		const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
		if (entry[1] === root && !entry[1].schema.id) return { ref: uriPrefix };
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + encodeJSONPointerSegment(defId)
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") extractToDef(entry);
		}
	}
	if (ctx.external) ctx.sharedDefsExtractedFor = ctx.external;
}
/** Rewrites `anyOf: [{type: "a"}, {type: "b"}]` to `type: ["a", "b"]`, which every JSON Schema draft treats as equivalent and most consumers render far better for the nullable case. Only branches that are a bare type assertion qualify — anything carrying a constraint, `$ref`, `const` or metadata is left alone. Runs after `flattenRef`, so a branch an override decorated or `$defs` extraction turned into a `$ref` is no longer bare and correctly stays in `anyOf`. `oneOf` is excluded: `integer` and `number` overlap, so "exactly one" and "at least one" are not the same there. OpenAPI 3.0 is excluded: its `type` must be a single string. */
function compactTypeUnion(schema) {
	const options = schema.anyOf;
	if (!Array.isArray(options) || options.length === 0 || schema.type !== void 0) return;
	const types = [];
	for (const option of options) {
		if (!option || typeof option !== "object") return;
		compactTypeUnion(option);
		const keys = Object.keys(option);
		if (keys.length !== 1 || keys[0] !== "type") return;
		const type = option.type;
		for (const member of Array.isArray(type) ? type : [type]) {
			if (typeof member !== "string") return;
			if (!types.includes(member)) types.push(member);
		}
	}
	delete schema.anyOf;
	schema.type = types.length === 1 ? types[0] : types;
}
/** Keywords `foldIntersection` knows how to combine. Anything else — `$ref`, `patternProperties`,
* an annotation like `description` — makes a member unfoldable, so a constraint this does not
* understand leaves the `allOf` alone instead of being silently dropped or misattributed. */
const FOLDABLE_KEYS = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties"
]);
const UNION_KEYS = ["oneOf", "anyOf"];
/** A member's constraint on a key it does not declare itself. A `catchall` states one; `false`, an absent `additionalProperties`, and the empty schema a loose object emits state nothing. */
function undeclaredConstraint(member) {
	const extra = member.additionalProperties;
	if (extra === void 0 || extra === false || typeof extra !== "object" || extra === null) return null;
	return Object.keys(extra).length ? extra : null;
}
/** Combines object members into the single object they describe together, or returns `null` if any of them carries a keyword outside {@link FOLDABLE_KEYS}. */
function foldObjects(members) {
	const objects = [];
	for (const member of members) {
		if (typeof member !== "object" || member.type !== "object") return null;
		for (const key in member) if (!FOLDABLE_KEYS.has(key)) return null;
		objects.push(member);
	}
	const properties = {};
	const required = /* @__PURE__ */ new Set();
	for (const object of objects) {
		for (const key in object.properties) {
			if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
			const parts = [];
			for (const other of objects) {
				const part = other.properties?.[key] ?? undeclaredConstraint(other);
				if (part === null || part === void 0) continue;
				if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part))) parts.push(part);
			}
			assignProp(properties, key, parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts });
		}
		for (const key of object.required ?? []) required.add(key);
	}
	const folded = {
		type: "object",
		properties
	};
	if (required.size) folded.required = [...required];
	if (objects.every((object) => object.additionalProperties === false)) folded.additionalProperties = false;
	else {
		const constraints = [];
		for (const object of objects) {
			const constraint = undeclaredConstraint(object);
			if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint))) constraints.push(constraint);
		}
		if (constraints.length === 1) folded.additionalProperties = constraints[0];
		else if (constraints.length > 1) folded.additionalProperties = { allOf: constraints };
	}
	return folded;
}
/** `additionalProperties` in an `allOf` member sees only that member's own `properties`, so two
* closed object members reject each other's keys and the schema validates nothing. Zod's parser
* pools the key sets instead — `handleIntersectionResults` reports a key as unrecognized only when
* *every* side rejects it — so the emitted schema has to pool them too, and folding the members
* into one object is the encoding that says so on every target.
*
* This runs from `finalize`, after `extractDefs`, which is what keeps it clear of the `$ref`
* machinery: a member extracted into `$defs` is already a `$ref` by now and declines to fold, so it
* keeps its reference and its own closedness rather than being inlined as a stale copy. */
function foldIntersection(json) {
	const allOf = json.allOf;
	if (!Array.isArray(allOf) || allOf.length < 2) return;
	for (const key of FOLDABLE_KEYS) if (key in json) return;
	const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
	let folded = null;
	if (!unions.length) folded = foldObjects(allOf);
	else {
		const union = unions[0];
		const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]));
		if (Object.keys(union).length !== 1) return;
		const rest = allOf.filter((m) => m !== union);
		const branches = union[keyword].map((branch) => foldObjects([...rest, branch]));
		if (branches.some((b) => !b)) return;
		folded = { [keyword]: branches };
	}
	if (!folded) return;
	delete json.allOf;
	assignProps(json, folded);
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else assignProps(schema, refSchema);
			assignProps(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
		for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
		if (ctx.target !== "openapi-3.0") for (const entry of ctx.seen.entries()) compactTypeUnion(entry[1].def ?? entry[1].schema);
		for (const rewrite of ctx.deferred) rewrite();
		if (ctx.intersections.length) {
			const carriers = /* @__PURE__ */ new Map();
			for (const seen of ctx.seen.values()) for (const json of [seen.schema, seen.def]) {
				const allOf = json?.allOf;
				if (!Array.isArray(allOf)) continue;
				const existing = carriers.get(allOf);
				if (existing) existing.push(json);
				else carriers.set(allOf, [json]);
			}
			for (const allOf of ctx.intersections) for (const json of carriers.get(allOf) ?? []) foldIntersection(json);
		}
	}
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
	const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
	if (rootMetaId !== void 0 && result.id === rootMetaId) delete result.id;
	const defs = ctx.external?.defs ?? {};
	if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) {
			if (seen.def.id === seen.defId) delete seen.def.id;
			assignProp(defs, seen.defId, seen.def);
		}
	}
	if (ctx.external) ctx.sharedEmitDoneFor = ctx.external;
	if (ctx.external) {} else if (Object.keys(defs).length > 0) if (ctx.target === "draft-2020-12") result.$defs = defs;
	else result.definitions = defs;
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault" || def.type === "catch") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") {
		if (_schema._zod.traits.has("$ZodCodec")) return true;
		return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	}
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
const createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	processSchema(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
const createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	processSchema(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/json-schema-processors.js
const narrowMin = (agg, key, value) => {
	if (agg[key] === void 0 || value > agg[key]) agg[key] = value;
};
const narrowMax = (agg, key, value) => {
	if (agg[key] === void 0 || value < agg[key]) agg[key] = value;
};
const narrowBoth = (agg, value) => {
	narrowMin(agg, "minimum", value);
	narrowMax(agg, "maximum", value);
};
const addDivisor = (agg, value) => {
	agg.multipleOf ?? (agg.multipleOf = []);
	if (!agg.multipleOf.includes(value)) agg.multipleOf.push(value);
};
const addPattern = (agg, pattern) => {
	agg.patterns ?? (agg.patterns = /* @__PURE__ */ new Set());
	agg.patterns.add(pattern);
};
const intersectMime = (agg, mime) => {
	agg.mime = agg.mime ? agg.mime.filter((m) => mime.includes(m)) : [...mime];
};
const setFormat = (agg, format) => {
	agg.format = format;
	if (format.includes("int")) agg.isInt = true;
};
const minContributor = (agg, def) => narrowMin(agg, "minimum", def.minimum);
const maxContributor = (agg, def) => narrowMax(agg, "maximum", def.maximum);
const formatContributor = (ranges) => (agg, def) => {
	setFormat(agg, def.format);
	const [minimum, maximum] = ranges[def.format];
	narrowMin(agg, "minimum", minimum);
	narrowMax(agg, "maximum", maximum);
};
const contributors = {
	greater_than: (agg, def) => narrowMin(agg, def.inclusive ? "minimum" : "exclusiveMinimum", def.value),
	less_than: (agg, def) => narrowMax(agg, def.inclusive ? "maximum" : "exclusiveMaximum", def.value),
	multiple_of: (agg, def) => addDivisor(agg, def.value),
	number_format: formatContributor(NUMBER_FORMAT_RANGES),
	bigint_format: formatContributor(BIGINT_FORMAT_RANGES),
	min_length: minContributor,
	max_length: maxContributor,
	length_equals: (agg, def) => narrowBoth(agg, def.length),
	min_size: minContributor,
	max_size: maxContributor,
	size_equals: (agg, def) => narrowBoth(agg, def.size),
	string_format: (agg, def) => {
		setFormat(agg, def.format);
		if (def.pattern) addPattern(agg, def.pattern);
		if (def.format === "base64" || def.format === "base64url") agg.contentEncoding = def.format;
		if (def.local || def.precision === -1) agg.laxFormat = true;
	},
	mime_type: (agg, def) => intersectMime(agg, def.mime)
};
function aggregateChecks(schema) {
	const agg = {};
	const def = schema._zod.def;
	const list = schema._zod.traits.has("$ZodCheck") ? [schema, ...def.checks ?? []] : def.checks ?? [];
	for (const ch of list) contributors[ch._zod.def.check]?.(agg, ch._zod.def);
	const bag = schema._zod.bag;
	if (bag.minimum !== void 0) narrowMin(agg, "minimum", bag.minimum);
	if (bag.exclusiveMinimum !== void 0) narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
	if (bag.maximum !== void 0) narrowMax(agg, "maximum", bag.maximum);
	if (bag.exclusiveMaximum !== void 0) narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
	if (bag.multipleOf !== void 0) addDivisor(agg, bag.multipleOf);
	if (bag.format !== void 0) {
		agg.format ?? (agg.format = bag.format);
		if (bag.format.includes("int")) agg.isInt = true;
	}
	if (bag.mime) intersectMime(agg, bag.mime);
	for (const pattern of bag.patterns ?? []) addPattern(agg, pattern);
	return agg;
}
const formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
const exactPatterns = new Map([[base64Charset, base64], [base64urlCharset, base64url]]);
const exactPattern = (p) => exactPatterns.get(p) ?? p;
const stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggregateChecks(schema);
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time" || laxFormat) delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const patternList = [...patterns].map(exactPattern);
		if (patternList.length === 1) json.pattern = patternList[0].source;
		else if (patternList.length > 1) json.allOf = [...patternList.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
const numberProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggregateChecks(schema);
	json.type = isInt ? "integer" : "number";
	const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
	const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
	const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
	if (exMin) if (legacy) {
		json.minimum = exclusiveMinimum;
		json.exclusiveMinimum = true;
	} else json.exclusiveMinimum = exclusiveMinimum;
	else if (typeof minimum === "number") json.minimum = minimum;
	if (exMax) if (legacy) {
		json.maximum = exclusiveMaximum;
		json.exclusiveMaximum = true;
	} else json.exclusiveMaximum = exclusiveMaximum;
	else if (typeof maximum === "number") json.maximum = maximum;
	if (multipleOf) {
		const divisors = /* @__PURE__ */ new Set();
		for (const divisor of multipleOf) if (Number.isFinite(divisor) && divisor !== 0) divisors.add(Math.abs(divisor));
		else handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
		const [first, ...rest] = divisors;
		if (first !== void 0) json.multipleOf = first;
		if (rest.length) json.allOf = [...json.allOf ?? [], ...rest.map((m) => ({ multipleOf: m }))];
	}
};
const booleanProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
const neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
const enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.length === 0) {
		json.not = {};
		return;
	}
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
const literalProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	if (def.values.length === 0) {
		json.not = {};
		return;
	}
	const vals = [];
	for (const val of def.values) if (val === void 0) {
		if (handleUnrepresentable(schema, ctx, json, params, "Literal `undefined` cannot be represented in JSON Schema")) return;
	} else if (typeof val === "bigint") {
		if (handleUnrepresentable(schema, ctx, json, params, "BigInt literals cannot be represented in JSON Schema")) return;
		vals.push(Number(val));
	} else vals.push(val);
	if (vals.length === 0) {} else if (vals.length === 1) {
		const val = vals[0];
		json.type = val === null ? "null" : typeof val;
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") json.enum = [val];
		else json.const = val;
	} else {
		if (vals.every((v) => typeof v === "number")) json.type = "number";
		if (vals.every((v) => typeof v === "string")) json.type = "string";
		if (vals.every((v) => typeof v === "boolean")) json.type = "boolean";
		if (vals.every((v) => v === null)) json.type = "null";
		json.enum = vals;
	}
};
const customProcessor = (schema, ctx, json, params) => {
	handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
};
const transformProcessor = (schema, ctx, json, params) => {
	handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
};
const arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = aggregateChecks(schema);
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = processSchema(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
function inputOptin(schema) {
	const def = schema._zod.def;
	if (def.type === "pipe" && def.in._zod.traits.has("$ZodTransform")) return inputOptin(def.out);
	if (def.type === "catch") return inputOptin(def.innerType);
	return schema._zod.optin;
}
const objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const shape = def.shape;
	if (Object.getOwnPropertySymbols(shape).length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) return;
	json.type = "object";
	json.properties = {};
	for (const key in shape) assignProp(json.properties, key, processSchema(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	}));
	const requiredKeys = [];
	for (const key of Object.keys(shape)) {
		const field = def.shape[key];
		if (ctx.io === "input" ? inputOptin(field) === void 0 : field._zod.optout === void 0) requiredKeys.push(key);
	}
	if (requiredKeys.length > 0) json.required = requiredKeys;
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = processSchema(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
const unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => processSchema(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
const intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = processSchema(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = processSchema(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	const allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
	json.allOf = allOf;
	ctx.intersections.push(allOf);
};
const nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
const nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
/** Round-trips a default value through JSON so the emitted schema is guaranteed to be valid JSON.
* A BigInt has no reliable encoding, so it goes through `unrepresentable` like any other
* unrepresentable value. Returns a sentinel when the caller must not write a default of its own. */
const UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(value, schema, ctx, json, params) {
	let unrepresentable = false;
	const serialized = JSON.stringify(value, (_, val) => {
		if (typeof val !== "bigint") return val;
		unrepresentable = true;
		return null;
	});
	if (!unrepresentable) return JSON.parse(serialized);
	handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
	return UNREPRESENTABLE_DEFAULT;
}
const defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
	if (value !== UNREPRESENTABLE_DEFAULT) json.default = value;
};
const prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io !== "input") return;
	const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
	if (value !== UNREPRESENTABLE_DEFAULT) json._prefault = value;
};
const catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
		return;
	}
	json.default = catchValue;
};
const pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const inIsTransform = def.in._zod.traits.has("$ZodTransform");
	const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
	processSchema(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
const readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
const optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/classic/errors.js
const _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
function _lazyMethod(proto, key, make) {
	Object.defineProperty(proto, key, {
		configurable: true,
		enumerable: false,
		get() {
			const value = make(this);
			Object.defineProperty(this, key, {
				value,
				configurable: true,
				writable: true
			});
			return value;
		},
		set(value) {
			Object.defineProperty(this, key, {
				value,
				configurable: true,
				writable: true
			});
		}
	});
}
const initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	const proto = Object.getPrototypeOf(inst);
	if (_installedErrorProtos.has(proto)) return;
	_installedErrorProtos.add(proto);
	_lazyMethod(proto, "format", (self) => (mapper) => formatError(self, mapper));
	_lazyMethod(proto, "flatten", (self) => (mapper) => flattenError(self, mapper));
	_lazyMethod(proto, "addIssue", (self) => (issue) => {
		self.issues.push(issue);
		self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
	});
	_lazyMethod(proto, "addIssues", (self) => (issues) => {
		self.issues.push(...issues);
		self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
	});
	Object.defineProperty(proto, "isEmpty", {
		configurable: true,
		enumerable: false,
		get() {
			return this.issues.length === 0;
		}
	});
};
const ZodRealError = /*@__PURE__*/ $constructor("ZodError", initializer, void 0, { Parent: Error });
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/classic/parse.js
const parse = /* @__PURE__ */ _parse(ZodRealError);
const parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
const safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
const safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
const encode = /* @__PURE__ */ _encode(ZodRealError);
const decode = /* @__PURE__ */ _decode(ZodRealError);
const encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
const decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
const safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
const safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
const safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
const safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
	if (!globalConfig.localeError) config(en_default());
}
function _ensureDefaultMemoizer() {
	if (!globalConfig.memoizer) config({ memoizer: memoizer() });
}
const ZodType = /*@__PURE__*/ $constructor("ZodType", (inst, def) => {
	_ensureDefaultLocale();
	$ZodType.init(inst, def);
	inst.def = def;
	inst.type = def.type;
	return inst;
}, {
	check(...chks) {
		const def = this.def;
		return this.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...chks.map((ch) => typeof ch === "function" ? { _zod: {
			check: ch,
			def: { check: "custom" },
			onattach: []
		} } : ch)] }), { parent: true });
	},
	with(...chks) {
		return this.check(...chks);
	},
	clone(def, params) {
		return clone(this, def, params);
	},
	brand() {
		return this;
	},
	register(reg, meta) {
		reg.add(this, meta);
		return this;
	},
	refine(check, params) {
		return this.check(refine(check, params));
	},
	superRefine(refinement, params) {
		return this.check(superRefine(refinement, params));
	},
	overwrite(fn) {
		return this.check(/* @__PURE__ */ _overwrite(fn));
	},
	optional() {
		return optional(this);
	},
	exactOptional() {
		return exactOptional(this);
	},
	nullable() {
		return nullable(this);
	},
	nullish() {
		return optional(nullable(this));
	},
	nonoptional(params) {
		return nonoptional(this, params);
	},
	array() {
		return array(this);
	},
	or(arg) {
		return union([this, arg]);
	},
	and(arg) {
		return intersection(this, arg);
	},
	transform(tx) {
		return pipe(this, transform(tx));
	},
	default(d) {
		return _default$1(this, d);
	},
	prefault(d) {
		return prefault(this, d);
	},
	catch(params) {
		return _catch(this, params);
	},
	pipe(target) {
		return pipe(this, target);
	},
	readonly() {
		return readonly(this);
	},
	describe(description) {
		const cl = this.clone();
		globalRegistry.add(cl, { description });
		return cl;
	},
	meta(...args) {
		if (args.length === 0) return globalRegistry.get(this);
		const cl = this.clone();
		globalRegistry.add(cl, args[0]);
		return cl;
	},
	isOptional() {
		return this.safeParse(void 0).success;
	},
	isNullable() {
		return this.safeParse(null).success;
	},
	apply(fn, ...args) {
		return args.length === 0 ? fn(this) : fn(this, ...args);
	},
	get "~standard"() {
		return hide(this, "~standard", {
			...standardProps(this),
			jsonSchema: {
				input: createStandardJSONSchemaMethod(this, "input"),
				output: createStandardJSONSchemaMethod(this, "output")
			}
		});
	},
	set "~standard"(value) {
		own(this, "~standard", value);
	},
	parse: function _parse(data, params) {
		return parse(this, data, params, { callee: _parse });
	},
	parseAsync: async function _parseAsync(data, params) {
		return await parseAsync(this, data, params, { callee: _parseAsync });
	},
	safeParse(data, params) {
		return safeParse(this, data, params);
	},
	async safeParseAsync(data, params) {
		return safeParseAsync(this, data, params);
	},
	get spa() {
		return this?.safeParseAsync;
	},
	set spa(value) {
		own(this, "spa", value);
	},
	validate(data, params) {
		return validate(this, data, params);
	},
	validateAsync(data, params) {
		return validateAsync$1(this, data, params);
	},
	encode: function _encode(data, params) {
		return encode(this, data, params, { callee: _encode });
	},
	decode: function _decode(data, params) {
		return decode(this, data, params, { callee: _decode });
	},
	encodeAsync: async function _encodeAsync(data, params) {
		return await encodeAsync(this, data, params, { callee: _encodeAsync });
	},
	decodeAsync: async function _decodeAsync(data, params) {
		return await decodeAsync(this, data, params, { callee: _decodeAsync });
	},
	safeEncode(data, params) {
		return safeEncode(this, data, params);
	},
	safeDecode(data, params) {
		return safeDecode(this, data, params);
	},
	async safeEncodeAsync(data, params) {
		return safeEncodeAsync(this, data, params);
	},
	async safeDecodeAsync(data, params) {
		return safeDecodeAsync(this, data, params);
	},
	toJSONSchema(params) {
		return createToJSONSchemaMethod(this, {})(params);
	},
	get description() {
		return globalRegistry.get(this)?.description;
	},
	get _def() {
		return this._zod.def;
	}
});
/** @internal */
const _ZodString = /*@__PURE__*/ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
}, /*@__PURE__*/ derived({
	format: (inst) => aggregateChecks(inst).format ?? null,
	minLength: (inst) => aggregateChecks(inst).minimum ?? null,
	maxLength: (inst) => aggregateChecks(inst).maximum ?? null
}, {
	regex(...args) {
		return this.check(/* @__PURE__ */ _regex(...args));
	},
	includes(...args) {
		return this.check(/* @__PURE__ */ _includes(...args));
	},
	startsWith(...args) {
		return this.check(/* @__PURE__ */ _startsWith(...args));
	},
	endsWith(...args) {
		return this.check(/* @__PURE__ */ _endsWith(...args));
	},
	min(...args) {
		return this.check(/* @__PURE__ */ _minLength(...args));
	},
	max(...args) {
		return this.check(/* @__PURE__ */ _maxLength(...args));
	},
	length(...args) {
		return this.check(/* @__PURE__ */ _length(...args));
	},
	nonempty(...args) {
		return this.check(/* @__PURE__ */ _minLength(1, ...args));
	},
	lowercase(params) {
		return this.check(/* @__PURE__ */ _lowercase(params));
	},
	uppercase(params) {
		return this.check(/* @__PURE__ */ _uppercase(params));
	},
	trim() {
		return this.check(/* @__PURE__ */ _trim());
	},
	normalize(...args) {
		return this.check(/* @__PURE__ */ _normalize(...args));
	},
	toLowerCase() {
		return this.check(/* @__PURE__ */ _toLowerCase());
	},
	toUpperCase() {
		return this.check(/* @__PURE__ */ _toUpperCase());
	},
	slugify() {
		return this.check(/* @__PURE__ */ _slugify());
	}
}));
const ZodString = /*@__PURE__*/ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
}, {
	email(params) {
		return this.check(/* @__PURE__ */ _email(ZodEmail, params));
	},
	url(params) {
		return this.check(/* @__PURE__ */ _url(ZodURL, params));
	},
	jwt(params) {
		return this.check(/* @__PURE__ */ _jwt(ZodJWT, params));
	},
	emoji(params) {
		return this.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
	},
	guid(params) {
		return this.check(/* @__PURE__ */ _guid(ZodGUID, params));
	},
	uuid(params) {
		return this.check(/* @__PURE__ */ _uuid(ZodUUID, params));
	},
	uuidv4(params) {
		return this.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
	},
	uuidv6(params) {
		return this.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
	},
	uuidv7(params) {
		return this.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
	},
	nanoid(params) {
		return this.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
	},
	cuid(params) {
		return this.check(/* @__PURE__ */ _cuid(ZodCUID, params));
	},
	cuid2(params) {
		return this.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
	},
	ulid(params) {
		return this.check(/* @__PURE__ */ _ulid(ZodULID, params));
	},
	base64(params) {
		return this.check(/* @__PURE__ */ _base64(ZodBase64, params));
	},
	base64url(params) {
		return this.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
	},
	xid(params) {
		return this.check(/* @__PURE__ */ _xid(ZodXID, params));
	},
	ksuid(params) {
		return this.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
	},
	ipv4(params) {
		return this.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
	},
	ipv6(params) {
		return this.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
	},
	cidrv4(params) {
		return this.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
	},
	cidrv6(params) {
		return this.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
	},
	e164(params) {
		return this.check(/* @__PURE__ */ _e164(ZodE164, params));
	},
	datetime(params) {
		return this.check(/* @__PURE__ */ _isoDateTime(ZodISODateTime, params));
	},
	date(params) {
		return this.check(/* @__PURE__ */ _isoDate(ZodISODate, params));
	},
	time(params) {
		return this.check(/* @__PURE__ */ _isoTime(ZodISOTime, params));
	},
	duration(params) {
		return this.check(/* @__PURE__ */ _isoDuration(ZodISODuration, params));
	}
});
function string(params) {
	return /* @__PURE__ */ _string(ZodString, params);
}
const ZodStringFormat = /*@__PURE__*/ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
const ZodISODateTime = /*@__PURE__*/ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodISODate = /*@__PURE__*/ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodISOTime = /*@__PURE__*/ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodISODuration = /*@__PURE__*/ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodEmail = /*@__PURE__*/ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodGUID = /*@__PURE__*/ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodUUID = /*@__PURE__*/ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function uuid(params) {
	return /* @__PURE__ */ _uuid(ZodUUID, params);
}
const ZodURL = /*@__PURE__*/ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodEmoji = /*@__PURE__*/ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNanoID = /*@__PURE__*/ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const ZodCUID = /*@__PURE__*/ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCUID2 = /*@__PURE__*/ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodULID = /*@__PURE__*/ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodXID = /*@__PURE__*/ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodKSUID = /*@__PURE__*/ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv4 = /*@__PURE__*/ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv6 = /*@__PURE__*/ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv4 = /*@__PURE__*/ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv6 = /*@__PURE__*/ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64 = /*@__PURE__*/ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64URL = /*@__PURE__*/ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodE164 = /*@__PURE__*/ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodJWT = /*@__PURE__*/ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNumber = /*@__PURE__*/ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	inst.isFinite = true;
}, /*@__PURE__*/ derived({
	minValue: (inst) => {
		const { minimum, exclusiveMinimum } = aggregateChecks(inst);
		return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
	},
	maxValue: (inst) => {
		const { maximum, exclusiveMaximum } = aggregateChecks(inst);
		return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
	},
	isInt: (inst) => {
		const { isInt, multipleOf } = aggregateChecks(inst);
		return !!isInt || !!multipleOf?.some(Number.isSafeInteger);
	},
	format: (inst) => aggregateChecks(inst).format ?? null
}, {
	gt(value, params) {
		return this.check(/* @__PURE__ */ _gt(value, params));
	},
	gte(value, params) {
		return this.check(/* @__PURE__ */ _gte(value, params));
	},
	min(value, params) {
		return this.check(/* @__PURE__ */ _gte(value, params));
	},
	lt(value, params) {
		return this.check(/* @__PURE__ */ _lt(value, params));
	},
	lte(value, params) {
		return this.check(/* @__PURE__ */ _lte(value, params));
	},
	max(value, params) {
		return this.check(/* @__PURE__ */ _lte(value, params));
	},
	int(params) {
		return this.check(int$1(params));
	},
	safe(params) {
		return this.check(int$1(params));
	},
	positive(params) {
		return this.check(/* @__PURE__ */ _gt(0, params));
	},
	nonnegative(params) {
		return this.check(/* @__PURE__ */ _gte(0, params));
	},
	negative(params) {
		return this.check(/* @__PURE__ */ _lt(0, params));
	},
	nonpositive(params) {
		return this.check(/* @__PURE__ */ _lte(0, params));
	},
	multipleOf(value, params) {
		return this.check(/* @__PURE__ */ _multipleOf(value, params));
	},
	step(value, params) {
		return this.check(/* @__PURE__ */ _multipleOf(value, params));
	},
	finite() {
		return this;
	}
}));
function number(params) {
	return /* @__PURE__ */ _number(ZodNumber, params);
}
const ZodNumberFormat = /*@__PURE__*/ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int$1(params) {
	return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
const ZodBoolean = /*@__PURE__*/ $constructor("ZodBoolean", (inst, def) => {
	$ZodBoolean.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean(params) {
	return /* @__PURE__ */ _boolean(ZodBoolean, params);
}
const ZodUnknown = /*@__PURE__*/ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => void 0;
});
function unknown() {
	return /* @__PURE__ */ _unknown(ZodUnknown);
}
const ZodNever = /*@__PURE__*/ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return /* @__PURE__ */ _never(ZodNever, params);
}
const ZodArray = /*@__PURE__*/ $constructor("ZodArray", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
}, {
	min(n, params) {
		return this.check(/* @__PURE__ */ _minLength(n, params));
	},
	nonempty(params) {
		return this.check(/* @__PURE__ */ _minLength(1, params));
	},
	max(n, params) {
		return this.check(/* @__PURE__ */ _maxLength(n, params));
	},
	length(n, params) {
		return this.check(/* @__PURE__ */ _length(n, params));
	},
	unwrap() {
		return this.element;
	}
});
function array(element, params) {
	return /* @__PURE__ */ _array(ZodArray, element, params);
}
const ZodObject = /*@__PURE__*/ $constructor("ZodObject", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
}, {
	keyof() {
		return _enum(Object.keys(this._zod.def.shape));
	},
	catchall(catchall) {
		return this.clone(mergeDefs(this._zod.def, { catchall }));
	},
	passthrough() {
		return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
	},
	loose() {
		return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
	},
	strict() {
		return this.clone(mergeDefs(this._zod.def, { catchall: never() }));
	},
	strip() {
		return this.clone(mergeDefs(this._zod.def, { catchall: void 0 }));
	},
	extend(incoming) {
		return extend(this, incoming);
	},
	safeExtend(incoming) {
		return safeExtend(this, incoming);
	},
	merge(other) {
		return merge$2(this, other);
	},
	pick(mask) {
		return pick(this, mask);
	},
	omit(mask) {
		return omit$1(this, mask);
	},
	partial(...args) {
		return partial(ZodOptional, this, args[0]);
	},
	exactPartial(...args) {
		return partial(ZodExactOptional, this, args[0], "exactPartial");
	},
	required(...args) {
		return required(ZodNonOptional, this, args[0]);
	}
});
function object$1(shape, params) {
	return new ZodObject({
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	});
}
function looseObject(shape, params) {
	return new ZodObject({
		type: "object",
		shape,
		catchall: unknown(),
		...normalizeParams(params)
	});
}
const ZodUnion = /*@__PURE__*/ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
const ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("ZodDiscriminatedUnion", (inst, def) => {
	ZodUnion.init(inst, def);
	$ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
	return new ZodDiscriminatedUnion({
		type: "union",
		options,
		discriminator,
		...normalizeParams(params)
	});
}
const ZodIntersection = /*@__PURE__*/ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
const ZodEnum = /*@__PURE__*/ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = [...inst._zod.values];
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	return new ZodEnum({
		type: "enum",
		entries: Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values,
		...normalizeParams(params)
	});
}
const ZodLiteral = /*@__PURE__*/ $constructor("ZodLiteral", (inst, def) => {
	$ZodLiteral.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
	inst.values = new Set(def.values);
	Object.defineProperty(inst, "value", { get() {
		if (def.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
		return def.values[0];
	} });
});
function literal(value, params) {
	return new ZodLiteral({
		type: "literal",
		values: Array.isArray(value) ? value : [value],
		...normalizeParams(params)
	});
}
const ZodTransform = /*@__PURE__*/ $constructor("ZodTransform", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				if (!("input" in _issue)) _issue.input = payload.value;
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			return payload;
		});
		payload.value = output;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
const ZodOptional = /*@__PURE__*/ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
const ZodExactOptional = /*@__PURE__*/ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
const ZodNullable = /*@__PURE__*/ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
const ZodDefault = /*@__PURE__*/ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default$1(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodPrefault = /*@__PURE__*/ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodNonOptional = /*@__PURE__*/ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
const ZodCatch = /*@__PURE__*/ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : constantCatch(catchValue)
	});
}
const ZodPipe = /*@__PURE__*/ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
const ZodReadonly = /*@__PURE__*/ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
const ZodCustom = /*@__PURE__*/ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
	return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
	return /* @__PURE__ */ _superRefine(fn, params);
}
//#endregion
//#region ../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/classic/iso.js
function datetime(params) {
	return /* @__PURE__ */ _isoDateTime(ZodISODateTime, params);
}
//#endregion
//#region lib/types/settings-file.js
/** Shared shell settings storage; reads have no side effects and fields fail independently. */
const preferencesSchema = object$1({
	allowTestAuthPopupWindow: boolean(),
	channel: _enum(["nightly", "stable"])
});
const documentSchema = looseObject({ updates: looseObject({}).optional() });
/** A storage or validation failure; business consumers decide fallback or suspension. */
var DesktopSettingsFileError = class extends Error {
	problem;
	path;
	/**
	* @param problem - Stable failure classification and mutation outcome, when applicable.
	* @param path - Settings file location, never file contents.
	* @param options - Original filesystem error, when available.
	*/
	constructor(problem, path, options) {
		super(`desktop settings: ${problem.kind}: ${path}`, options);
		this.problem = problem;
		this.path = path;
	}
};
function field(schema, value, name, path) {
	if (value === void 0) return { kind: "absent" };
	const result = schema.safeParse(value);
	return result.success ? {
		kind: "valid",
		value: result.data
	} : {
		kind: "invalid",
		error: new DesktopSettingsFileError({
			kind: "invalid",
			reason: "field",
			field: name
		}, path)
	};
}
/**
* Validate a channel at the IPC boundary using the same schema as file loading.
* @param value - Untrusted input.
* @returns Whether the input is a supported channel.
*/
function isDesktopUpdateChannel(value) {
	return preferencesSchema.shape.channel.safeParse(value).success;
}
/**
* Resolve the document shared by shell preferences and update channels.
* @param userData - Electron userData, independent of Host and DSH_HOME.
* @returns Settings file path without filesystem changes.
*/
function desktopSettingsPath(userData) {
	return join(userData, "desktop", "settings.json");
}
/** File operations do not watch, cache, choose defaults or apply runtime preferences. */
var DesktopSettingsFile = class {
	path;
	/** @param userData - Electron userData, independent of Host and DSH_HOME. */
	constructor(userData) {
		this.path = desktopSettingsPath(userData);
	}
	/** @returns Fresh file and field states; performs no creation or repair. */
	async read() {
		let raw;
		try {
			raw = await readFile$1(this.path, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return { kind: "missing" };
			return {
				kind: "error",
				error: new DesktopSettingsFileError({ kind: "read" }, this.path, { cause: error })
			};
		}
		let value;
		try {
			value = JSON.parse(raw);
		} catch (_error) {
			return {
				kind: "error",
				error: new DesktopSettingsFileError({
					kind: "invalid",
					reason: "json"
				}, this.path)
			};
		}
		return this.inspect(value);
	}
	inspect(value) {
		const result = documentSchema.safeParse(value);
		if (!result.success) return {
			kind: "error",
			error: new DesktopSettingsFileError({
				kind: "invalid",
				reason: "structure"
			}, this.path)
		};
		const document = result.data;
		return {
			kind: "ready",
			document,
			fields: {
				allowTestAuthPopupWindow: field(preferencesSchema.shape.allowTestAuthPopupWindow, document.updates?.allowTestAuthPopupWindow, "allowTestAuthPopupWindow", this.path),
				channel: field(preferencesSchema.shape.channel, document.updates?.channel, "channel", this.path)
			}
		};
	}
	/**
	* Explicit startup initialization; existing files, including invalid ones, are never replaced.
	* @returns Current file state after exclusive creation if missing, or a structured failure.
	*/
	async initialize() {
		const current = await this.read();
		if (current.kind !== "missing") return current;
		try {
			return await this.mutate({ kind: "initialize" });
		} catch (error) {
			if (!(error instanceof DesktopSettingsFileError)) throw error;
			return {
				kind: "error",
				error
			};
		}
	}
	/**
	* Patch known fields under the shared writer lock, preserving unknown and unrelated invalid fields.
	* Malformed JSON/structure is rejected; a missing document starts empty. External editors must
	* not write concurrently. No runtime settings change here. Write errors distinguish unchanged,
	* uncertain write completion, and a committed write whose lock cleanup failed; no rollback is attempted.
	* @param updates - Typed fields to replace; omitted keys remain unchanged.
	* @returns After atomic replacement and lock release; otherwise throws DesktopSettingsFileError.
	*/
	async saveUpdates(updates) {
		const result = await this.mutate({
			kind: "save",
			updates
		});
		if (result.kind === "error") throw result.error;
	}
	async mutate(request) {
		let effect = "unchanged";
		try {
			await mkdir(dirname(this.path), {
				recursive: true,
				mode: 448
			});
			return await withFileLock(this.path, async () => {
				const current = await this.read();
				if (current.kind === "error") throw current.error;
				if (request.kind === "initialize" && current.kind !== "missing") return current;
				const document = current.kind === "ready" ? current.document : {};
				const updates = request.kind === "initialize" ? { allowTestAuthPopupWindow: false } : request.updates;
				const next = {
					...document,
					updates: {
						...document.updates,
						...updates
					}
				};
				const raw = `${JSON.stringify(next, null, 2)}\n`;
				effect = "unknown";
				if (request.kind === "initialize") try {
					await writeFile(this.path, raw, {
						flag: "wx",
						mode: 384
					});
				} catch (error) {
					if (error.code !== "EEXIST") throw error;
					effect = "unchanged";
					return this.read();
				}
				else await writeFileAtomic(this.path, raw, { mode: 384 });
				effect = "written";
				return this.inspect(next);
			});
		} catch (error) {
			if (error instanceof DesktopSettingsFileError) throw error;
			throw new DesktopSettingsFileError({
				kind: "write",
				operation: request.kind,
				effect
			}, this.path, { cause: error });
		}
	}
};
//#endregion
//#region lib/types/update-configuration.js
/**
* Classify an unreadable startup selection without exposing file contents.
* @param error - Validated storage failure.
* @returns The persistent reason updates are suspended.
*/
function configurationFailure(error) {
	const problem = error.problem;
	if (problem.kind !== "invalid") return "read";
	return problem.reason === "field" && problem.field === "channel" ? "channel" : "format";
}
/**
* Reduce an operation failure to a short, trustworthy toast reason.
* @param error - Failed save or channel transition.
* @returns Safe detail for the initiating settings view.
*/
function channelSaveFailure(error) {
	if (!(error instanceof DesktopSettingsFileError)) return "apply";
	if (error.problem.kind === "write" && error.problem.effect === "unknown") return "uncertain";
	if (error.problem.kind === "invalid") return "format";
	const cause = error.cause;
	if (cause instanceof Error && "code" in cause && (cause.code === "EACCES" || cause.code === "EPERM")) return "permission";
	return "save";
}
/**
* Explain an actual suspension and its recovery action.
* @param reason - Persistent updater configuration failure.
* @param messages - Current desktop locale.
* @returns Localized dialog message.
*/
function configurationMessage(reason, messages) {
	return messages[{
		read: "updateConfigurationRead",
		format: "updateConfigurationFormat",
		channel: "updateConfigurationChannel",
		cleanup: "updateConfigurationCleanup"
	}[reason]];
}
//#endregion
//#region lib/types/update-settings.js
/** Channel-specific default and failure policy over the shared shell settings document. */
/** No file watching; loading and explicit UI saves share shell storage and validation. */
var DesktopUpdateSettings = class {
	packagedChannel;
	file;
	path;
	/**
	* @param userData - Electron userData, independent of Host and DSH_HOME.
	* @param packagedChannel - Default selected by the installer build input.
	*/
	constructor(userData, packagedChannel) {
		this.packagedChannel = packagedChannel;
		this.file = new DesktopSettingsFile(userData);
		this.path = this.file.path;
	}
	/** @returns Startup channel or an error requiring suspension; never creates a missing file. */
	async load() {
		const result = await this.file.read();
		if (result.kind === "error") return result;
		if (result.kind === "missing") return {
			kind: "ready",
			channel: this.packagedChannel
		};
		const channel = result.fields.channel;
		if (channel.kind === "invalid") return {
			kind: "error",
			error: channel.error
		};
		return {
			kind: "ready",
			channel: channel.kind === "valid" ? channel.value : this.packagedChannel
		};
	}
	/**
	* Save a selection while preserving other fields; never changes the runtime selection itself.
	* @param channel - Validated UI selection.
	* @returns After a confirmed write, including logged lock-release failures.
	* Uncertain writes reject without retry; diagnostics are appended to settings.json.save.jsonl.
	*/
	async save(channel) {
		try {
			await this.file.saveUpdates({ channel });
		} catch (error) {
			if (!(error instanceof DesktopSettingsFileError) || error.problem.kind !== "write") throw error;
			const entry = {
				time: (/* @__PURE__ */ new Date()).toISOString(),
				event: "settings-save-failed",
				effect: error.problem.effect,
				path: this.path,
				reason: error.cause instanceof Error ? error.cause.message : String(error.cause)
			};
			try {
				appendFileSync(`${this.path}.save.jsonl`, `${JSON.stringify(entry)}\n`, {
					mode: 384,
					flush: true
				});
			} catch (logError) {
				console.error("desktop settings: could not persist save warning", entry, logError);
			}
			if (error.problem.effect !== "written") throw error;
		}
	}
};
//#endregion
//#region ../../packages/util/home-paths/lib/index.js
/**
* Shared filesystem path helpers for DeepSeek Harness user data.
*
* @module @deepseek-ai/dsh-home-paths
*/
/** Directory name for the default DeepSeek Harness home under the OS home. */
const DSH_HOME_DIR_NAME = ".dsh";
/** Environment variable that overrides the default DeepSeek Harness home. */
const DSH_HOME_ENV = "DSH_HOME";
/**
* Resolve the default DeepSeek Harness home using Node's platform path rules.
* @returns the absolute default harness home path.
*/
function defaultDshHome() {
	return join(homedir(), DSH_HOME_DIR_NAME);
}
/**
* Expand supported tilde prefixes against the operating-system home.
* @param path - configured path that may begin with `~`, `~/`, or `~\`.
* @returns the expanded path, or the original value when no supported prefix is present.
*/
function expandHomePath(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}
/**
* Resolve one user-data root from an explicit path, an environment override, and a default.
* @param configured - explicit path, which has highest precedence.
* @param env - environment mapping to read.
* @param envName - environment variable that overrides the default.
* @param fallback - default root, used when neither the explicit path nor the environment provides one.
* @returns the normalized absolute root.
*/
function resolveRoot(configured, env, envName, fallback) {
	const fromEnv = env[envName];
	return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : fallback())));
}
/**
* Resolve the single-root DeepSeek Harness home.
*
* Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
* `~/.dsh`. The harness keeps all user data under one root. An empty or
* whitespace-only `$DSH_HOME` is treated as unset, so a blank override never
* resolves the home to the current working directory.
* @param configured - explicit harness-home override, which has highest precedence.
* @param env - environment mapping used to read `DSH_HOME`.
* @returns the normalized absolute harness home path.
*/
function resolveDshHome(configured, env = process.env) {
	return resolveRoot(configured, env, DSH_HOME_ENV, defaultDshHome);
}
//#endregion
//#region lib/types/paths.js
/** Filesystem ownership for the Electron-managed desktop installation. */
/**
* Resolve every Electron-owned path without changing the shared data roots.
* @param dshHome - Harness home shared with npm-installed dsh.
* @returns immutable desktop path set.
*/
function resolveDesktopPaths(dshHome = resolveDshHome()) {
	return {
		profile: join(dshHome, "profiles", "desktop"),
		lock: join(dshHome, "profiles", "desktop", "lock")
	};
}
//#endregion
//#region lib/types/core-package-set.js
/** Private package installed beside dsh to boot the Desktop Host process. */
const DESKTOP_HOST_PACKAGE = "@deepseek-ai/dsh-desktop-host";
//#endregion
//#region lib/types/runtime-tree.js
/** Descriptor at the root of the immutable Desktop resource tree. */
const DESKTOP_RUNTIME_FILE = "desktop-runtime.json";
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u;
promisify(readFile);
function record$4(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Read packaged metadata and check shared package records.
* @param root - Current application's runtime resources.
* @returns Runtime metadata whose release compatibility is verified during packaging.
*/
function readDesktopRuntime(root) {
	const value = JSON.parse(readFileSync(join(root, DESKTOP_RUNTIME_FILE), "utf8"));
	if (!record$4(value) || typeof value.platform !== "string" || typeof value.arch !== "string" || !Array.isArray(value.sharedPackages) || !Array.isArray(value.files)) throw new Error("desktop runtime: invalid descriptor");
	if (!record$4(value.release) || typeof value.release.version !== "string" || typeof value.release.nodeVersion !== "string" || typeof value.release.pnpmVersion !== "string") throw new Error("desktop runtime: invalid release fields");
	const release = value.release;
	const sharedPackages = value.sharedPackages.map((entry) => {
		if (!record$4(entry) || typeof entry.name !== "string" || !PACKAGE_NAME.test(entry.name) || typeof entry.version !== "string" || valid(entry.version) === null || entry.path !== `node_modules/${entry.name}`) throw new Error("desktop runtime: invalid shared package record");
		return {
			name: entry.name,
			version: entry.version,
			path: entry.path
		};
	});
	if (new Set(sharedPackages.map((entry) => entry.name)).size !== sharedPackages.length) throw new Error("desktop runtime: duplicate shared package");
	const files = value.files;
	for (const name of ["@deepseek-ai/dsh", DESKTOP_HOST_PACKAGE]) if (sharedPackages.find((entry) => entry.name === name)?.version !== release.version) throw new Error(`desktop runtime: missing or mismatched ${name}`);
	return {
		schemaVersion: value.schemaVersion,
		release,
		platform: value.platform,
		arch: value.arch,
		sharedPackages,
		files
	};
}
//#endregion
//#region ../../node_modules/.pnpm/js-yaml@4.3.2/node_modules/js-yaml/dist/js-yaml.mjs
function getDefaultExportFromCjs(x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var jsYaml = {};
var loader = {};
var common = {};
var hasRequiredCommon;
function requireCommon() {
	if (hasRequiredCommon) return common;
	hasRequiredCommon = 1;
	function isNothing(subject) {
		return typeof subject === "undefined" || subject === null;
	}
	function isObject(subject) {
		return typeof subject === "object" && subject !== null;
	}
	function toArray(sequence) {
		if (Array.isArray(sequence)) return sequence;
		else if (isNothing(sequence)) return [];
		return [sequence];
	}
	function extend(target, source) {
		if (source) {
			const sourceKeys = Object.keys(source);
			for (let index = 0, length = sourceKeys.length; index < length; index += 1) {
				const key = sourceKeys[index];
				target[key] = source[key];
			}
		}
		return target;
	}
	function repeat(string, count) {
		let result = "";
		for (let cycle = 0; cycle < count; cycle += 1) result += string;
		return result;
	}
	function isNegativeZero(number) {
		return number === 0 && Number.NEGATIVE_INFINITY === 1 / number;
	}
	common.isNothing = isNothing;
	common.isObject = isObject;
	common.toArray = toArray;
	common.repeat = repeat;
	common.isNegativeZero = isNegativeZero;
	common.extend = extend;
	return common;
}
var exception;
var hasRequiredException;
function requireException() {
	if (hasRequiredException) return exception;
	hasRequiredException = 1;
	function formatError(exception2, compact) {
		let where = "";
		const message = exception2.reason || "(unknown reason)";
		if (!exception2.mark) return message;
		if (exception2.mark.name) where += "in \"" + exception2.mark.name + "\" ";
		where += "(" + (exception2.mark.line + 1) + ":" + (exception2.mark.column + 1) + ")";
		if (!compact && exception2.mark.snippet) where += "\n\n" + exception2.mark.snippet;
		return message + " " + where;
	}
	function YAMLException2(reason, mark) {
		Error.call(this);
		this.name = "YAMLException";
		this.reason = reason;
		this.mark = mark;
		this.message = formatError(this, false);
		if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
		else this.stack = (/* @__PURE__ */ new Error()).stack || "";
	}
	YAMLException2.prototype = Object.create(Error.prototype);
	YAMLException2.prototype.constructor = YAMLException2;
	YAMLException2.prototype.toString = function toString(compact) {
		return this.name + ": " + formatError(this, compact);
	};
	exception = YAMLException2;
	return exception;
}
var snippet;
var hasRequiredSnippet;
function requireSnippet() {
	if (hasRequiredSnippet) return snippet;
	hasRequiredSnippet = 1;
	const common2 = requireCommon();
	function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
		let head = "";
		let tail = "";
		const maxHalfLength = Math.floor(maxLineLength / 2) - 1;
		if (position - lineStart > maxHalfLength) {
			head = " ... ";
			lineStart = position - maxHalfLength + head.length;
		}
		if (lineEnd - position > maxHalfLength) {
			tail = " ...";
			lineEnd = position + maxHalfLength - tail.length;
		}
		return {
			str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, "→") + tail,
			pos: position - lineStart + head.length
		};
	}
	function padStart(string, max) {
		return common2.repeat(" ", max - string.length) + string;
	}
	function makeSnippet(mark, options) {
		options = Object.create(options || null);
		if (!mark.buffer) return null;
		if (!options.maxLength) options.maxLength = 79;
		if (typeof options.indent !== "number") options.indent = 1;
		if (typeof options.linesBefore !== "number") options.linesBefore = 3;
		if (typeof options.linesAfter !== "number") options.linesAfter = 2;
		const re = /\r?\n|\r|\0/g;
		const lineStarts = [0];
		const lineEnds = [];
		let match;
		let foundLineNo = -1;
		while (match = re.exec(mark.buffer)) {
			lineEnds.push(match.index);
			lineStarts.push(match.index + match[0].length);
			if (mark.position <= match.index && foundLineNo < 0) foundLineNo = lineStarts.length - 2;
		}
		if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
		let result = "";
		const lineNoLength = Math.min(mark.line + options.linesAfter, lineEnds.length).toString().length;
		const maxLineLength = options.maxLength - (options.indent + lineNoLength + 3);
		for (let i = 1; i <= options.linesBefore; i++) {
			if (foundLineNo - i < 0) break;
			const line2 = getLine(mark.buffer, lineStarts[foundLineNo - i], lineEnds[foundLineNo - i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]), maxLineLength);
			result = common2.repeat(" ", options.indent) + padStart((mark.line - i + 1).toString(), lineNoLength) + " | " + line2.str + "\n" + result;
		}
		const line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
		result += common2.repeat(" ", options.indent) + padStart((mark.line + 1).toString(), lineNoLength) + " | " + line.str + "\n";
		result += common2.repeat("-", options.indent + lineNoLength + 3 + line.pos) + "^\n";
		for (let i = 1; i <= options.linesAfter; i++) {
			if (foundLineNo + i >= lineEnds.length) break;
			const line2 = getLine(mark.buffer, lineStarts[foundLineNo + i], lineEnds[foundLineNo + i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]), maxLineLength);
			result += common2.repeat(" ", options.indent) + padStart((mark.line + i + 1).toString(), lineNoLength) + " | " + line2.str + "\n";
		}
		return result.replace(/\n$/, "");
	}
	snippet = makeSnippet;
	return snippet;
}
var type;
var hasRequiredType;
function requireType() {
	if (hasRequiredType) return type;
	hasRequiredType = 1;
	const YAMLException2 = requireException();
	const TYPE_CONSTRUCTOR_OPTIONS = [
		"kind",
		"multi",
		"resolve",
		"construct",
		"instanceOf",
		"predicate",
		"represent",
		"representName",
		"defaultStyle",
		"styleAliases"
	];
	const YAML_NODE_KINDS = [
		"scalar",
		"sequence",
		"mapping"
	];
	function compileStyleAliases(map2) {
		const result = {};
		if (map2 !== null) Object.keys(map2).forEach(function(style) {
			map2[style].forEach(function(alias) {
				result[String(alias)] = style;
			});
		});
		return result;
	}
	function Type2(tag, options) {
		options = options || {};
		Object.keys(options).forEach(function(name) {
			if (TYPE_CONSTRUCTOR_OPTIONS.indexOf(name) === -1) throw new YAMLException2("Unknown option \"" + name + "\" is met in definition of \"" + tag + "\" YAML type.");
		});
		this.options = options;
		this.tag = tag;
		this.kind = options["kind"] || null;
		this.resolve = options["resolve"] || function() {
			return true;
		};
		this.construct = options["construct"] || function(data) {
			return data;
		};
		this.instanceOf = options["instanceOf"] || null;
		this.predicate = options["predicate"] || null;
		this.represent = options["represent"] || null;
		this.representName = options["representName"] || null;
		this.defaultStyle = options["defaultStyle"] || null;
		this.multi = options["multi"] || false;
		this.styleAliases = compileStyleAliases(options["styleAliases"] || null);
		if (YAML_NODE_KINDS.indexOf(this.kind) === -1) throw new YAMLException2("Unknown kind \"" + this.kind + "\" is specified for \"" + tag + "\" YAML type.");
	}
	type = Type2;
	return type;
}
var schema$1;
var hasRequiredSchema;
function requireSchema() {
	if (hasRequiredSchema) return schema$1;
	hasRequiredSchema = 1;
	const YAMLException2 = requireException();
	const Type2 = requireType();
	function compileList(schema2, name) {
		const result = [];
		schema2[name].forEach(function(currentType) {
			let newIndex = result.length;
			result.forEach(function(previousType, previousIndex) {
				if (previousType.tag === currentType.tag && previousType.kind === currentType.kind && previousType.multi === currentType.multi) newIndex = previousIndex;
			});
			result[newIndex] = currentType;
		});
		return result;
	}
	function compileMap() {
		const result = {
			scalar: {},
			sequence: {},
			mapping: {},
			fallback: {},
			multi: {
				scalar: [],
				sequence: [],
				mapping: [],
				fallback: []
			}
		};
		function collectType(type2) {
			if (type2.multi) {
				result.multi[type2.kind].push(type2);
				result.multi["fallback"].push(type2);
			} else result[type2.kind][type2.tag] = result["fallback"][type2.tag] = type2;
		}
		for (let index = 0, length = arguments.length; index < length; index += 1) arguments[index].forEach(collectType);
		return result;
	}
	function Schema2(definition) {
		return this.extend(definition);
	}
	Schema2.prototype.extend = function extend(definition) {
		let implicit = [];
		let explicit = [];
		if (definition instanceof Type2) explicit.push(definition);
		else if (Array.isArray(definition)) explicit = explicit.concat(definition);
		else if (definition && (Array.isArray(definition.implicit) || Array.isArray(definition.explicit))) {
			if (definition.implicit) implicit = implicit.concat(definition.implicit);
			if (definition.explicit) explicit = explicit.concat(definition.explicit);
		} else throw new YAMLException2("Schema.extend argument should be a Type, [ Type ], or a schema definition ({ implicit: [...], explicit: [...] })");
		implicit.forEach(function(type2) {
			if (!(type2 instanceof Type2)) throw new YAMLException2("Specified list of YAML types (or a single Type object) contains a non-Type object.");
			if (type2.loadKind && type2.loadKind !== "scalar") throw new YAMLException2("There is a non-scalar type in the implicit list of a schema. Implicit resolving of such types is not supported.");
			if (type2.multi) throw new YAMLException2("There is a multi type in the implicit list of a schema. Multi tags can only be listed as explicit.");
		});
		explicit.forEach(function(type2) {
			if (!(type2 instanceof Type2)) throw new YAMLException2("Specified list of YAML types (or a single Type object) contains a non-Type object.");
		});
		const result = Object.create(Schema2.prototype);
		result.implicit = (this.implicit || []).concat(implicit);
		result.explicit = (this.explicit || []).concat(explicit);
		result.compiledImplicit = compileList(result, "implicit");
		result.compiledExplicit = compileList(result, "explicit");
		result.compiledTypeMap = compileMap(result.compiledImplicit, result.compiledExplicit);
		return result;
	};
	schema$1 = Schema2;
	return schema$1;
}
var str;
var hasRequiredStr;
function requireStr() {
	if (hasRequiredStr) return str;
	hasRequiredStr = 1;
	str = new (requireType())("tag:yaml.org,2002:str", {
		kind: "scalar",
		construct: function(data) {
			return data !== null ? data : "";
		}
	});
	return str;
}
var seq;
var hasRequiredSeq;
function requireSeq() {
	if (hasRequiredSeq) return seq;
	hasRequiredSeq = 1;
	seq = new (requireType())("tag:yaml.org,2002:seq", {
		kind: "sequence",
		construct: function(data) {
			return data !== null ? data : [];
		}
	});
	return seq;
}
var map;
var hasRequiredMap;
function requireMap() {
	if (hasRequiredMap) return map;
	hasRequiredMap = 1;
	map = new (requireType())("tag:yaml.org,2002:map", {
		kind: "mapping",
		construct: function(data) {
			return data !== null ? data : {};
		}
	});
	return map;
}
var failsafe;
var hasRequiredFailsafe;
function requireFailsafe() {
	if (hasRequiredFailsafe) return failsafe;
	hasRequiredFailsafe = 1;
	failsafe = new (requireSchema())({ explicit: [
		requireStr(),
		requireSeq(),
		requireMap()
	] });
	return failsafe;
}
var _null;
var hasRequired_null;
function require_null() {
	if (hasRequired_null) return _null;
	hasRequired_null = 1;
	const Type2 = requireType();
	function resolveYamlNull(data) {
		if (data === null) return true;
		const max = data.length;
		return max === 1 && data === "~" || max === 4 && (data === "null" || data === "Null" || data === "NULL");
	}
	function constructYamlNull() {
		return null;
	}
	function isNull(object) {
		return object === null;
	}
	_null = new Type2("tag:yaml.org,2002:null", {
		kind: "scalar",
		resolve: resolveYamlNull,
		construct: constructYamlNull,
		predicate: isNull,
		represent: {
			canonical: function() {
				return "~";
			},
			lowercase: function() {
				return "null";
			},
			uppercase: function() {
				return "NULL";
			},
			camelcase: function() {
				return "Null";
			},
			empty: function() {
				return "";
			}
		},
		defaultStyle: "lowercase"
	});
	return _null;
}
var bool;
var hasRequiredBool;
function requireBool() {
	if (hasRequiredBool) return bool;
	hasRequiredBool = 1;
	const Type2 = requireType();
	function resolveYamlBoolean(data) {
		if (data === null) return false;
		const max = data.length;
		return max === 4 && (data === "true" || data === "True" || data === "TRUE") || max === 5 && (data === "false" || data === "False" || data === "FALSE");
	}
	function constructYamlBoolean(data) {
		return data === "true" || data === "True" || data === "TRUE";
	}
	function isBoolean(object) {
		return Object.prototype.toString.call(object) === "[object Boolean]";
	}
	bool = new Type2("tag:yaml.org,2002:bool", {
		kind: "scalar",
		resolve: resolveYamlBoolean,
		construct: constructYamlBoolean,
		predicate: isBoolean,
		represent: {
			lowercase: function(object) {
				return object ? "true" : "false";
			},
			uppercase: function(object) {
				return object ? "TRUE" : "FALSE";
			},
			camelcase: function(object) {
				return object ? "True" : "False";
			}
		},
		defaultStyle: "lowercase"
	});
	return bool;
}
var int;
var hasRequiredInt;
function requireInt() {
	if (hasRequiredInt) return int;
	hasRequiredInt = 1;
	const common2 = requireCommon();
	const Type2 = requireType();
	function isHexCode(c) {
		return c >= 48 && c <= 57 || c >= 65 && c <= 70 || c >= 97 && c <= 102;
	}
	function isOctCode(c) {
		return c >= 48 && c <= 55;
	}
	function isDecCode(c) {
		return c >= 48 && c <= 57;
	}
	function resolveYamlInteger(data) {
		if (data === null) return false;
		const max = data.length;
		let index = 0;
		let hasDigits = false;
		if (!max) return false;
		let ch = data[index];
		if (ch === "-" || ch === "+") ch = data[++index];
		if (ch === "0") {
			if (index + 1 === max) return true;
			ch = data[++index];
			if (ch === "b") {
				index++;
				for (; index < max; index++) {
					ch = data[index];
					if (ch !== "0" && ch !== "1") return false;
					hasDigits = true;
				}
				return hasDigits && isFinite(parseYamlInteger(data));
			}
			if (ch === "x") {
				index++;
				for (; index < max; index++) {
					if (!isHexCode(data.charCodeAt(index))) return false;
					hasDigits = true;
				}
				return hasDigits && isFinite(parseYamlInteger(data));
			}
			if (ch === "o") {
				index++;
				for (; index < max; index++) {
					if (!isOctCode(data.charCodeAt(index))) return false;
					hasDigits = true;
				}
				return hasDigits && isFinite(parseYamlInteger(data));
			}
		}
		for (; index < max; index++) {
			if (!isDecCode(data.charCodeAt(index))) return false;
			hasDigits = true;
		}
		if (!hasDigits) return false;
		return isFinite(parseYamlInteger(data));
	}
	function parseYamlInteger(data) {
		let value = data;
		let sign = 1;
		let ch = value[0];
		if (ch === "-" || ch === "+") {
			if (ch === "-") sign = -1;
			value = value.slice(1);
			ch = value[0];
		}
		if (value === "0") return 0;
		if (ch === "0") {
			if (value[1] === "b") return sign * parseInt(value.slice(2), 2);
			if (value[1] === "x") return sign * parseInt(value.slice(2), 16);
			if (value[1] === "o") return sign * parseInt(value.slice(2), 8);
		}
		return sign * parseInt(value, 10);
	}
	function constructYamlInteger(data) {
		return parseYamlInteger(data);
	}
	function isInteger(object) {
		return Object.prototype.toString.call(object) === "[object Number]" && object % 1 === 0 && !common2.isNegativeZero(object);
	}
	int = new Type2("tag:yaml.org,2002:int", {
		kind: "scalar",
		resolve: resolveYamlInteger,
		construct: constructYamlInteger,
		predicate: isInteger,
		represent: {
			binary: function(obj) {
				return obj >= 0 ? "0b" + obj.toString(2) : "-0b" + obj.toString(2).slice(1);
			},
			octal: function(obj) {
				return obj >= 0 ? "0o" + obj.toString(8) : "-0o" + obj.toString(8).slice(1);
			},
			decimal: function(obj) {
				return obj.toString(10);
			},
			hexadecimal: function(obj) {
				return obj >= 0 ? "0x" + obj.toString(16).toUpperCase() : "-0x" + obj.toString(16).toUpperCase().slice(1);
			}
		},
		defaultStyle: "decimal",
		styleAliases: {
			binary: [2, "bin"],
			octal: [8, "oct"],
			decimal: [10, "dec"],
			hexadecimal: [16, "hex"]
		}
	});
	return int;
}
var float;
var hasRequiredFloat;
function requireFloat() {
	if (hasRequiredFloat) return float;
	hasRequiredFloat = 1;
	const common2 = requireCommon();
	const Type2 = requireType();
	const YAML_FLOAT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?(?:[0-9]+)(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
	const YAML_FLOAT_SPECIAL_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
	function resolveYamlFloat(data) {
		if (data === null) return false;
		if (!YAML_FLOAT_PATTERN.test(data)) return false;
		if (isFinite(parseFloat(data, 10))) return true;
		return YAML_FLOAT_SPECIAL_PATTERN.test(data);
	}
	function constructYamlFloat(data) {
		let value = data.toLowerCase();
		const sign = value[0] === "-" ? -1 : 1;
		if ("+-".indexOf(value[0]) >= 0) value = value.slice(1);
		if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
		else if (value === ".nan") return NaN;
		return sign * parseFloat(value, 10);
	}
	const SCIENTIFIC_WITHOUT_DOT = /^[-+]?[0-9]+e/;
	function representYamlFloat(object, style) {
		if (isNaN(object)) switch (style) {
			case "lowercase": return ".nan";
			case "uppercase": return ".NAN";
			case "camelcase": return ".NaN";
		}
		else if (Number.POSITIVE_INFINITY === object) switch (style) {
			case "lowercase": return ".inf";
			case "uppercase": return ".INF";
			case "camelcase": return ".Inf";
		}
		else if (Number.NEGATIVE_INFINITY === object) switch (style) {
			case "lowercase": return "-.inf";
			case "uppercase": return "-.INF";
			case "camelcase": return "-.Inf";
		}
		else if (common2.isNegativeZero(object)) return "-0.0";
		const res = object.toString(10);
		return SCIENTIFIC_WITHOUT_DOT.test(res) ? res.replace("e", ".e") : res;
	}
	function isFloat(object) {
		return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 !== 0 || common2.isNegativeZero(object));
	}
	float = new Type2("tag:yaml.org,2002:float", {
		kind: "scalar",
		resolve: resolveYamlFloat,
		construct: constructYamlFloat,
		predicate: isFloat,
		represent: representYamlFloat,
		defaultStyle: "lowercase"
	});
	return float;
}
var json;
var hasRequiredJson;
function requireJson() {
	if (hasRequiredJson) return json;
	hasRequiredJson = 1;
	json = requireFailsafe().extend({ implicit: [
		require_null(),
		requireBool(),
		requireInt(),
		requireFloat()
	] });
	return json;
}
var core;
var hasRequiredCore;
function requireCore() {
	if (hasRequiredCore) return core;
	hasRequiredCore = 1;
	core = requireJson();
	return core;
}
var timestamp;
var hasRequiredTimestamp;
function requireTimestamp() {
	if (hasRequiredTimestamp) return timestamp;
	hasRequiredTimestamp = 1;
	const Type2 = requireType();
	const YAML_DATE_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$");
	const YAML_TIMESTAMP_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$");
	function resolveYamlTimestamp(data) {
		if (data === null) return false;
		if (YAML_DATE_REGEXP.exec(data) !== null) return true;
		if (YAML_TIMESTAMP_REGEXP.exec(data) !== null) return true;
		return false;
	}
	function constructYamlTimestamp(data) {
		let fraction = 0;
		let delta = null;
		let match = YAML_DATE_REGEXP.exec(data);
		if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(data);
		if (match === null) throw new Error("Date resolve error");
		const year = +match[1];
		const month = +match[2] - 1;
		const day = +match[3];
		if (!match[4]) return new Date(Date.UTC(year, month, day));
		const hour = +match[4];
		const minute = +match[5];
		const second = +match[6];
		if (match[7]) {
			fraction = match[7].slice(0, 3);
			while (fraction.length < 3) fraction += "0";
			fraction = +fraction;
		}
		if (match[9]) {
			const tzHour = +match[10];
			const tzMinute = +(match[11] || 0);
			delta = (tzHour * 60 + tzMinute) * 6e4;
			if (match[9] === "-") delta = -delta;
		}
		const date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
		if (delta) date.setTime(date.getTime() - delta);
		return date;
	}
	function representYamlTimestamp(object) {
		return object.toISOString();
	}
	timestamp = new Type2("tag:yaml.org,2002:timestamp", {
		kind: "scalar",
		resolve: resolveYamlTimestamp,
		construct: constructYamlTimestamp,
		instanceOf: Date,
		represent: representYamlTimestamp
	});
	return timestamp;
}
var merge$1;
var hasRequiredMerge;
function requireMerge() {
	if (hasRequiredMerge) return merge$1;
	hasRequiredMerge = 1;
	const Type2 = requireType();
	function resolveYamlMerge(data) {
		return data === "<<" || data === null;
	}
	merge$1 = new Type2("tag:yaml.org,2002:merge", {
		kind: "scalar",
		resolve: resolveYamlMerge
	});
	return merge$1;
}
var binary;
var hasRequiredBinary;
function requireBinary() {
	if (hasRequiredBinary) return binary;
	hasRequiredBinary = 1;
	const Type2 = requireType();
	const BASE64_MAP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r";
	function resolveYamlBinary(data) {
		if (data === null) return false;
		let bitlen = 0;
		const max = data.length;
		const map2 = BASE64_MAP;
		for (let idx = 0; idx < max; idx++) {
			const code = map2.indexOf(data.charAt(idx));
			if (code > 64) continue;
			if (code < 0) return false;
			bitlen += 6;
		}
		return bitlen % 8 === 0;
	}
	function constructYamlBinary(data) {
		const input = data.replace(/[\r\n=]/g, "");
		const max = input.length;
		const map2 = BASE64_MAP;
		let bits = 0;
		const result = [];
		for (let idx = 0; idx < max; idx++) {
			if (idx % 4 === 0 && idx) {
				result.push(bits >> 16 & 255);
				result.push(bits >> 8 & 255);
				result.push(bits & 255);
			}
			bits = bits << 6 | map2.indexOf(input.charAt(idx));
		}
		const tailbits = max % 4 * 6;
		if (tailbits === 0) {
			result.push(bits >> 16 & 255);
			result.push(bits >> 8 & 255);
			result.push(bits & 255);
		} else if (tailbits === 18) {
			result.push(bits >> 10 & 255);
			result.push(bits >> 2 & 255);
		} else if (tailbits === 12) result.push(bits >> 4 & 255);
		return new Uint8Array(result);
	}
	function representYamlBinary(object) {
		let result = "";
		let bits = 0;
		const max = object.length;
		const map2 = BASE64_MAP;
		for (let idx = 0; idx < max; idx++) {
			if (idx % 3 === 0 && idx) {
				result += map2[bits >> 18 & 63];
				result += map2[bits >> 12 & 63];
				result += map2[bits >> 6 & 63];
				result += map2[bits & 63];
			}
			bits = (bits << 8) + object[idx];
		}
		const tail = max % 3;
		if (tail === 0) {
			result += map2[bits >> 18 & 63];
			result += map2[bits >> 12 & 63];
			result += map2[bits >> 6 & 63];
			result += map2[bits & 63];
		} else if (tail === 2) {
			result += map2[bits >> 10 & 63];
			result += map2[bits >> 4 & 63];
			result += map2[bits << 2 & 63];
			result += map2[64];
		} else if (tail === 1) {
			result += map2[bits >> 2 & 63];
			result += map2[bits << 4 & 63];
			result += map2[64];
			result += map2[64];
		}
		return result;
	}
	function isBinary(obj) {
		return Object.prototype.toString.call(obj) === "[object Uint8Array]";
	}
	binary = new Type2("tag:yaml.org,2002:binary", {
		kind: "scalar",
		resolve: resolveYamlBinary,
		construct: constructYamlBinary,
		predicate: isBinary,
		represent: representYamlBinary
	});
	return binary;
}
var omap;
var hasRequiredOmap;
function requireOmap() {
	if (hasRequiredOmap) return omap;
	hasRequiredOmap = 1;
	const Type2 = requireType();
	const _hasOwnProperty = Object.prototype.hasOwnProperty;
	const _toString = Object.prototype.toString;
	function resolveYamlOmap(data) {
		if (data === null) return true;
		const objectKeys = {};
		const object = data;
		for (let index = 0, length = object.length; index < length; index += 1) {
			const pair = object[index];
			let pairHasKey = false;
			if (_toString.call(pair) !== "[object Object]") return false;
			let pairKey;
			for (pairKey in pair) if (_hasOwnProperty.call(pair, pairKey)) if (!pairHasKey) pairHasKey = true;
			else return false;
			if (!pairHasKey) return false;
			if (_hasOwnProperty.call(objectKeys, pairKey)) return false;
			Object.defineProperty(objectKeys, pairKey, { value: true });
		}
		return true;
	}
	function constructYamlOmap(data) {
		return data !== null ? data : [];
	}
	omap = new Type2("tag:yaml.org,2002:omap", {
		kind: "sequence",
		resolve: resolveYamlOmap,
		construct: constructYamlOmap
	});
	return omap;
}
var pairs;
var hasRequiredPairs;
function requirePairs() {
	if (hasRequiredPairs) return pairs;
	hasRequiredPairs = 1;
	const Type2 = requireType();
	const _toString = Object.prototype.toString;
	function resolveYamlPairs(data) {
		if (data === null) return true;
		const object = data;
		const result = new Array(object.length);
		for (let index = 0, length = object.length; index < length; index += 1) {
			const pair = object[index];
			if (_toString.call(pair) !== "[object Object]") return false;
			const keys = Object.keys(pair);
			if (keys.length !== 1) return false;
			result[index] = [keys[0], pair[keys[0]]];
		}
		return true;
	}
	function constructYamlPairs(data) {
		if (data === null) return [];
		const object = data;
		const result = new Array(object.length);
		for (let index = 0, length = object.length; index < length; index += 1) {
			const pair = object[index];
			const keys = Object.keys(pair);
			result[index] = [keys[0], pair[keys[0]]];
		}
		return result;
	}
	pairs = new Type2("tag:yaml.org,2002:pairs", {
		kind: "sequence",
		resolve: resolveYamlPairs,
		construct: constructYamlPairs
	});
	return pairs;
}
var set;
var hasRequiredSet;
function requireSet() {
	if (hasRequiredSet) return set;
	hasRequiredSet = 1;
	const Type2 = requireType();
	const _hasOwnProperty = Object.prototype.hasOwnProperty;
	function resolveYamlSet(data) {
		if (data === null) return true;
		const object = data;
		for (const key in object) if (_hasOwnProperty.call(object, key)) {
			if (object[key] !== null) return false;
		}
		return true;
	}
	function constructYamlSet(data) {
		return data !== null ? data : {};
	}
	set = new Type2("tag:yaml.org,2002:set", {
		kind: "mapping",
		resolve: resolveYamlSet,
		construct: constructYamlSet
	});
	return set;
}
var _default;
var hasRequired_default;
function require_default() {
	if (hasRequired_default) return _default;
	hasRequired_default = 1;
	_default = requireCore().extend({
		implicit: [requireTimestamp(), requireMerge()],
		explicit: [
			requireBinary(),
			requireOmap(),
			requirePairs(),
			requireSet()
		]
	});
	return _default;
}
var hasRequiredLoader;
function requireLoader() {
	if (hasRequiredLoader) return loader;
	hasRequiredLoader = 1;
	const common2 = requireCommon();
	const YAMLException2 = requireException();
	const makeSnippet = requireSnippet();
	const DEFAULT_SCHEMA2 = require_default();
	const _hasOwnProperty = Object.prototype.hasOwnProperty;
	const CONTEXT_FLOW_IN = 1;
	const CONTEXT_FLOW_OUT = 2;
	const CONTEXT_BLOCK_IN = 3;
	const CONTEXT_BLOCK_OUT = 4;
	const CHOMPING_CLIP = 1;
	const CHOMPING_STRIP = 2;
	const CHOMPING_KEEP = 3;
	const PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
	const PATTERN_NON_ASCII_LINE_BREAKS = /[\x85\u2028\u2029]/;
	const PATTERN_FLOW_INDICATORS = /[,\[\]{}]/;
	const PATTERN_TAG_HANDLE = /^(?:!|!!|![0-9A-Za-z-]+!)$/;
	const PATTERN_TAG_URI = /^(?:!|[^,\[\]{}])(?:%[0-9a-f]{2}|[0-9a-z\-#;/?:@&=+$,_.!~*'()\[\]])*$/i;
	function _class(obj) {
		return Object.prototype.toString.call(obj);
	}
	function isEol(c) {
		return c === 10 || c === 13;
	}
	function isWhiteSpace(c) {
		return c === 9 || c === 32;
	}
	function isWsOrEol(c) {
		return c === 9 || c === 32 || c === 10 || c === 13;
	}
	function isFlowIndicator(c) {
		return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
	}
	function fromHexCode(c) {
		if (c >= 48 && c <= 57) return c - 48;
		const lc = c | 32;
		if (lc >= 97 && lc <= 102) return lc - 97 + 10;
		return -1;
	}
	function escapedHexLen(c) {
		if (c === 120) return 2;
		if (c === 117) return 4;
		if (c === 85) return 8;
		return 0;
	}
	function fromDecimalCode(c) {
		if (c >= 48 && c <= 57) return c - 48;
		return -1;
	}
	function simpleEscapeSequence(c) {
		switch (c) {
			case 48: return "\0";
			case 97: return "\x07";
			case 98: return "\b";
			case 116: return "	";
			case 9: return "	";
			case 110: return "\n";
			case 118: return "\v";
			case 102: return "\f";
			case 114: return "\r";
			case 101: return "\x1B";
			case 32: return " ";
			case 34: return "\"";
			case 47: return "/";
			case 92: return "\\";
			case 78: return "";
			case 95: return "\xA0";
			case 76: return "\u2028";
			case 80: return "\u2029";
			default: return "";
		}
	}
	function charFromCodepoint(c) {
		if (c <= 65535) return String.fromCharCode(c);
		return String.fromCharCode((c - 65536 >> 10) + 55296, (c - 65536 & 1023) + 56320);
	}
	function setProperty(object, key, value) {
		if (key === "__proto__") Object.defineProperty(object, key, {
			configurable: true,
			enumerable: true,
			writable: true,
			value
		});
		else object[key] = value;
	}
	const simpleEscapeCheck = new Array(256);
	const simpleEscapeMap = new Array(256);
	for (let i = 0; i < 256; i++) {
		simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
		simpleEscapeMap[i] = simpleEscapeSequence(i);
	}
	function State(input, options) {
		this.input = input;
		this.filename = options["filename"] || null;
		this.schema = options["schema"] || DEFAULT_SCHEMA2;
		this.onWarning = options["onWarning"] || null;
		this.legacy = options["legacy"] || false;
		this.json = options["json"] || false;
		this.listener = options["listener"] || null;
		this.maxDepth = typeof options["maxDepth"] === "number" ? options["maxDepth"] : 100;
		this.maxTotalMergeKeys = typeof options["maxTotalMergeKeys"] === "number" ? options["maxTotalMergeKeys"] : 1e4;
		this.implicitTypes = this.schema.compiledImplicit;
		this.typeMap = this.schema.compiledTypeMap;
		this.length = input.length;
		this.position = 0;
		this.line = 0;
		this.lineStart = 0;
		this.lineIndent = 0;
		this.depth = 0;
		this.totalMergeKeys = 0;
		this.firstTabInLine = -1;
		this.documents = [];
		this.anchorMapTransactions = [];
	}
	function generateError(state, message) {
		const mark = {
			name: state.filename,
			buffer: state.input.slice(0, -1),
			position: state.position,
			line: state.line,
			column: state.position - state.lineStart
		};
		mark.snippet = makeSnippet(mark);
		return new YAMLException2(message, mark);
	}
	function throwError(state, message) {
		throw generateError(state, message);
	}
	function throwWarning(state, message) {
		if (state.onWarning) state.onWarning.call(null, generateError(state, message));
	}
	function storeAnchor(state, name, value) {
		const transactions = state.anchorMapTransactions;
		if (transactions.length !== 0) {
			const transaction = transactions[transactions.length - 1];
			if (!_hasOwnProperty.call(transaction, name)) transaction[name] = {
				existed: _hasOwnProperty.call(state.anchorMap, name),
				value: state.anchorMap[name]
			};
		}
		state.anchorMap[name] = value;
	}
	function beginAnchorTransaction(state) {
		state.anchorMapTransactions.push(/* @__PURE__ */ Object.create(null));
	}
	function commitAnchorTransaction(state) {
		const transaction = state.anchorMapTransactions.pop();
		const transactions = state.anchorMapTransactions;
		if (transactions.length === 0) return;
		const parent = transactions[transactions.length - 1];
		const names = Object.keys(transaction);
		for (let index = 0, length = names.length; index < length; index += 1) {
			const name = names[index];
			if (!_hasOwnProperty.call(parent, name)) parent[name] = transaction[name];
		}
	}
	function rollbackAnchorTransaction(state) {
		const transaction = state.anchorMapTransactions.pop();
		const names = Object.keys(transaction);
		for (let index = names.length - 1; index >= 0; index -= 1) {
			const entry = transaction[names[index]];
			if (entry.existed) state.anchorMap[names[index]] = entry.value;
			else delete state.anchorMap[names[index]];
		}
	}
	function snapshotState(state) {
		return {
			position: state.position,
			line: state.line,
			lineStart: state.lineStart,
			lineIndent: state.lineIndent,
			firstTabInLine: state.firstTabInLine,
			tag: state.tag,
			anchor: state.anchor,
			kind: state.kind,
			result: state.result
		};
	}
	function restoreState(state, snapshot) {
		state.position = snapshot.position;
		state.line = snapshot.line;
		state.lineStart = snapshot.lineStart;
		state.lineIndent = snapshot.lineIndent;
		state.firstTabInLine = snapshot.firstTabInLine;
		state.tag = snapshot.tag;
		state.anchor = snapshot.anchor;
		state.kind = snapshot.kind;
		state.result = snapshot.result;
	}
	const directiveHandlers = {
		YAML: function handleYamlDirective(state, name, args) {
			if (state.version !== null) throwError(state, "duplication of %YAML directive");
			if (args.length !== 1) throwError(state, "YAML directive accepts exactly one argument");
			const match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
			if (match === null) throwError(state, "ill-formed argument of the YAML directive");
			const major = parseInt(match[1], 10);
			const minor = parseInt(match[2], 10);
			if (major !== 1) throwError(state, "unacceptable YAML version of the document");
			state.version = args[0];
			state.checkLineBreaks = minor < 2;
			if (minor !== 1 && minor !== 2) throwWarning(state, "unsupported YAML version of the document");
		},
		TAG: function handleTagDirective(state, name, args) {
			let prefix;
			if (args.length !== 2) throwError(state, "TAG directive accepts exactly two arguments");
			const handle = args[0];
			prefix = args[1];
			if (!PATTERN_TAG_HANDLE.test(handle)) throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
			if (_hasOwnProperty.call(state.tagMap, handle)) throwError(state, "there is a previously declared suffix for \"" + handle + "\" tag handle");
			if (!PATTERN_TAG_URI.test(prefix)) throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
			try {
				prefix = decodeURIComponent(prefix);
			} catch (err) {
				throwError(state, "tag prefix is malformed: " + prefix);
			}
			state.tagMap[handle] = prefix;
		}
	};
	function captureSegment(state, start, end, checkJson) {
		if (start < end) {
			const _result = state.input.slice(start, end);
			if (checkJson) for (let _position = 0, _length = _result.length; _position < _length; _position += 1) {
				const _character = _result.charCodeAt(_position);
				if (!(_character === 9 || _character >= 32 && _character <= 1114111)) throwError(state, "expected valid JSON character");
			}
			else if (PATTERN_NON_PRINTABLE.test(_result)) throwError(state, "the stream contains non-printable characters");
			state.result += _result;
		}
	}
	function chargeMergeWork(state) {
		state.totalMergeKeys++;
		if (state.maxTotalMergeKeys !== -1 && state.totalMergeKeys > state.maxTotalMergeKeys) throwError(state, "merge keys exceeded maxTotalMergeKeys (" + state.maxTotalMergeKeys + ")");
	}
	function mergeMappings(state, destination, source, overridableKeys) {
		if (!common2.isObject(source)) throwError(state, "cannot merge mappings; the provided source object is unacceptable");
		chargeMergeWork(state);
		const sourceKeys = Object.keys(source);
		for (let index = 0, quantity = sourceKeys.length; index < quantity; index += 1) {
			const key = sourceKeys[index];
			chargeMergeWork(state);
			if (!_hasOwnProperty.call(destination, key)) {
				setProperty(destination, key, source[key]);
				overridableKeys[key] = true;
			}
		}
	}
	function storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, startLine, startLineStart, startPos) {
		if (Array.isArray(keyNode)) {
			keyNode = Array.prototype.slice.call(keyNode);
			for (let index = 0, quantity = keyNode.length; index < quantity; index += 1) {
				if (Array.isArray(keyNode[index])) throwError(state, "nested arrays are not supported inside keys");
				if (typeof keyNode === "object" && _class(keyNode[index]) === "[object Object]") keyNode[index] = "[object Object]";
			}
		}
		if (typeof keyNode === "object" && _class(keyNode) === "[object Object]") keyNode = "[object Object]";
		keyNode = String(keyNode);
		if (_result === null) _result = {};
		if (keyTag === "tag:yaml.org,2002:merge") if (Array.isArray(valueNode)) {
			if (valueNode.length > 100) throwError(state, "abnormal merge sequence size");
			for (let index = 0, quantity = valueNode.length; index < quantity; index += 1) mergeMappings(state, _result, valueNode[index], overridableKeys);
		} else mergeMappings(state, _result, valueNode, overridableKeys);
		else {
			if (!state.json && !_hasOwnProperty.call(overridableKeys, keyNode) && _hasOwnProperty.call(_result, keyNode)) {
				state.line = startLine || state.line;
				state.lineStart = startLineStart || state.lineStart;
				state.position = startPos || state.position;
				throwError(state, "duplicated mapping key");
			}
			setProperty(_result, keyNode, valueNode);
			delete overridableKeys[keyNode];
		}
		return _result;
	}
	function readLineBreak(state) {
		const ch = state.input.charCodeAt(state.position);
		if (ch === 10) state.position++;
		else if (ch === 13) {
			state.position++;
			if (state.input.charCodeAt(state.position) === 10) state.position++;
		} else throwError(state, "a line break is expected");
		state.line += 1;
		state.lineStart = state.position;
		state.firstTabInLine = -1;
	}
	function skipSeparationSpace(state, allowComments, checkIndent) {
		let lineBreaks = 0;
		let ch = state.input.charCodeAt(state.position);
		while (ch !== 0) {
			while (isWhiteSpace(ch)) {
				if (ch === 9 && state.firstTabInLine === -1) state.firstTabInLine = state.position;
				ch = state.input.charCodeAt(++state.position);
			}
			if (allowComments && ch === 35) do
				ch = state.input.charCodeAt(++state.position);
			while (ch !== 10 && ch !== 13 && ch !== 0);
			if (isEol(ch)) {
				readLineBreak(state);
				ch = state.input.charCodeAt(state.position);
				lineBreaks++;
				state.lineIndent = 0;
				while (ch === 32) {
					state.lineIndent++;
					ch = state.input.charCodeAt(++state.position);
				}
			} else break;
		}
		if (checkIndent !== -1 && lineBreaks !== 0 && state.lineIndent < checkIndent) throwWarning(state, "deficient indentation");
		return lineBreaks;
	}
	function testDocumentSeparator(state) {
		let _position = state.position;
		let ch = state.input.charCodeAt(_position);
		if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(_position + 1) && ch === state.input.charCodeAt(_position + 2)) {
			_position += 3;
			ch = state.input.charCodeAt(_position);
			if (ch === 0 || isWsOrEol(ch)) return true;
		}
		return false;
	}
	function writeFoldedLines(state, count) {
		if (count === 1) state.result += " ";
		else if (count > 1) state.result += common2.repeat("\n", count - 1);
	}
	function readPlainScalar(state, nodeIndent, withinFlowCollection) {
		let captureStart;
		let captureEnd;
		let hasPendingContent;
		let _line;
		let _lineStart;
		let _lineIndent;
		const _kind = state.kind;
		const _result = state.result;
		let ch = state.input.charCodeAt(state.position);
		if (isWsOrEol(ch) || isFlowIndicator(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96) return false;
		if (ch === 63 || ch === 45) {
			const following = state.input.charCodeAt(state.position + 1);
			if (isWsOrEol(following) || withinFlowCollection && isFlowIndicator(following)) return false;
		}
		state.kind = "scalar";
		state.result = "";
		captureStart = captureEnd = state.position;
		hasPendingContent = false;
		while (ch !== 0) {
			if (ch === 58) {
				const following = state.input.charCodeAt(state.position + 1);
				if (isWsOrEol(following) || withinFlowCollection && isFlowIndicator(following)) break;
			} else if (ch === 35) {
				if (isWsOrEol(state.input.charCodeAt(state.position - 1))) break;
			} else if (state.position === state.lineStart && testDocumentSeparator(state) || withinFlowCollection && isFlowIndicator(ch)) break;
			else if (isEol(ch)) {
				_line = state.line;
				_lineStart = state.lineStart;
				_lineIndent = state.lineIndent;
				skipSeparationSpace(state, false, -1);
				if (state.lineIndent >= nodeIndent) {
					hasPendingContent = true;
					ch = state.input.charCodeAt(state.position);
					continue;
				} else {
					state.position = captureEnd;
					state.line = _line;
					state.lineStart = _lineStart;
					state.lineIndent = _lineIndent;
					break;
				}
			}
			if (hasPendingContent) {
				captureSegment(state, captureStart, captureEnd, false);
				writeFoldedLines(state, state.line - _line);
				captureStart = captureEnd = state.position;
				hasPendingContent = false;
			}
			if (!isWhiteSpace(ch)) captureEnd = state.position + 1;
			ch = state.input.charCodeAt(++state.position);
		}
		captureSegment(state, captureStart, captureEnd, false);
		if (state.result) return true;
		state.kind = _kind;
		state.result = _result;
		return false;
	}
	function readSingleQuotedScalar(state, nodeIndent) {
		let captureStart;
		let captureEnd;
		let ch = state.input.charCodeAt(state.position);
		if (ch !== 39) return false;
		state.kind = "scalar";
		state.result = "";
		state.position++;
		captureStart = captureEnd = state.position;
		while ((ch = state.input.charCodeAt(state.position)) !== 0) if (ch === 39) {
			captureSegment(state, captureStart, state.position, true);
			ch = state.input.charCodeAt(++state.position);
			if (ch === 39) {
				captureStart = state.position;
				state.position++;
				captureEnd = state.position;
			} else return true;
		} else if (isEol(ch)) {
			captureSegment(state, captureStart, captureEnd, true);
			writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
			captureStart = captureEnd = state.position;
		} else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a single quoted scalar");
		else {
			state.position++;
			if (!isWhiteSpace(ch)) captureEnd = state.position;
		}
		throwError(state, "unexpected end of the stream within a single quoted scalar");
	}
	function readDoubleQuotedScalar(state, nodeIndent) {
		let captureStart;
		let captureEnd;
		let tmp;
		let ch = state.input.charCodeAt(state.position);
		if (ch !== 34) return false;
		state.kind = "scalar";
		state.result = "";
		state.position++;
		captureStart = captureEnd = state.position;
		while ((ch = state.input.charCodeAt(state.position)) !== 0) if (ch === 34) {
			captureSegment(state, captureStart, state.position, true);
			state.position++;
			return true;
		} else if (ch === 92) {
			captureSegment(state, captureStart, state.position, true);
			ch = state.input.charCodeAt(++state.position);
			if (isEol(ch)) skipSeparationSpace(state, false, nodeIndent);
			else if (ch < 256 && simpleEscapeCheck[ch]) {
				state.result += simpleEscapeMap[ch];
				state.position++;
			} else if ((tmp = escapedHexLen(ch)) > 0) {
				let hexLength = tmp;
				let hexResult = 0;
				for (; hexLength > 0; hexLength--) {
					ch = state.input.charCodeAt(++state.position);
					if ((tmp = fromHexCode(ch)) >= 0) hexResult = (hexResult << 4) + tmp;
					else throwError(state, "expected hexadecimal character");
				}
				state.result += charFromCodepoint(hexResult);
				state.position++;
			} else throwError(state, "unknown escape sequence");
			captureStart = captureEnd = state.position;
		} else if (isEol(ch)) {
			captureSegment(state, captureStart, captureEnd, true);
			writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
			captureStart = captureEnd = state.position;
		} else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a double quoted scalar");
		else {
			state.position++;
			if (!isWhiteSpace(ch)) captureEnd = state.position;
		}
		throwError(state, "unexpected end of the stream within a double quoted scalar");
	}
	function readFlowCollection(state, nodeIndent) {
		let readNext = true;
		let _line;
		let _lineStart;
		let _pos;
		const _tag = state.tag;
		let _result;
		const _anchor = state.anchor;
		let terminator;
		let isPair;
		let isExplicitPair;
		let isMapping;
		const overridableKeys = /* @__PURE__ */ Object.create(null);
		let keyNode;
		let keyTag;
		let valueNode;
		let ch = state.input.charCodeAt(state.position);
		if (ch === 91) {
			terminator = 93;
			isMapping = false;
			_result = [];
		} else if (ch === 123) {
			terminator = 125;
			isMapping = true;
			_result = {};
		} else return false;
		if (state.anchor !== null) storeAnchor(state, state.anchor, _result);
		ch = state.input.charCodeAt(++state.position);
		while (ch !== 0) {
			skipSeparationSpace(state, true, nodeIndent);
			ch = state.input.charCodeAt(state.position);
			if (ch === terminator) {
				state.position++;
				state.tag = _tag;
				state.anchor = _anchor;
				state.kind = isMapping ? "mapping" : "sequence";
				state.result = _result;
				return true;
			} else if (!readNext) throwError(state, "missed comma between flow collection entries");
			else if (ch === 44) throwError(state, "expected the node content, but found ','");
			keyTag = keyNode = valueNode = null;
			isPair = isExplicitPair = false;
			if (ch === 63) {
				if (isWsOrEol(state.input.charCodeAt(state.position + 1))) {
					isPair = isExplicitPair = true;
					state.position++;
					skipSeparationSpace(state, true, nodeIndent);
				}
			}
			_line = state.line;
			_lineStart = state.lineStart;
			_pos = state.position;
			composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
			keyTag = state.tag;
			keyNode = state.result;
			skipSeparationSpace(state, true, nodeIndent);
			ch = state.input.charCodeAt(state.position);
			if ((isExplicitPair || state.line === _line) && ch === 58) {
				isPair = true;
				ch = state.input.charCodeAt(++state.position);
				skipSeparationSpace(state, true, nodeIndent);
				composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
				valueNode = state.result;
			}
			if (isMapping) storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos);
			else if (isPair) _result.push(storeMappingPair(state, null, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos));
			else _result.push(keyNode);
			skipSeparationSpace(state, true, nodeIndent);
			ch = state.input.charCodeAt(state.position);
			if (ch === 44) {
				readNext = true;
				ch = state.input.charCodeAt(++state.position);
			} else readNext = false;
		}
		throwError(state, "unexpected end of the stream within a flow collection");
	}
	function readBlockScalar(state, nodeIndent) {
		let folding;
		let chomping = CHOMPING_CLIP;
		let didReadContent = false;
		let detectedIndent = false;
		let textIndent = nodeIndent;
		let emptyLines = 0;
		let atMoreIndented = false;
		let tmp;
		let ch = state.input.charCodeAt(state.position);
		if (ch === 124) folding = false;
		else if (ch === 62) folding = true;
		else return false;
		state.kind = "scalar";
		state.result = "";
		while (ch !== 0) {
			ch = state.input.charCodeAt(++state.position);
			if (ch === 43 || ch === 45) if (CHOMPING_CLIP === chomping) chomping = ch === 43 ? CHOMPING_KEEP : CHOMPING_STRIP;
			else throwError(state, "repeat of a chomping mode identifier");
			else if ((tmp = fromDecimalCode(ch)) >= 0) if (tmp === 0) throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
			else if (!detectedIndent) {
				textIndent = nodeIndent + tmp - 1;
				detectedIndent = true;
			} else throwError(state, "repeat of an indentation width identifier");
			else break;
		}
		if (isWhiteSpace(ch)) {
			do
				ch = state.input.charCodeAt(++state.position);
			while (isWhiteSpace(ch));
			if (ch === 35) do
				ch = state.input.charCodeAt(++state.position);
			while (!isEol(ch) && ch !== 0);
		}
		while (ch !== 0) {
			readLineBreak(state);
			state.lineIndent = 0;
			ch = state.input.charCodeAt(state.position);
			while ((!detectedIndent || state.lineIndent < textIndent) && ch === 32) {
				state.lineIndent++;
				ch = state.input.charCodeAt(++state.position);
			}
			if (!detectedIndent && state.lineIndent > textIndent) textIndent = state.lineIndent;
			if (isEol(ch)) {
				emptyLines++;
				continue;
			}
			if (!detectedIndent && textIndent === 0) throwError(state, "missing indentation for block scalar");
			if (state.lineIndent < textIndent) {
				if (chomping === CHOMPING_KEEP) state.result += common2.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
				else if (chomping === CHOMPING_CLIP) {
					if (didReadContent) state.result += "\n";
				}
				break;
			}
			if (folding) if (isWhiteSpace(ch)) {
				atMoreIndented = true;
				state.result += common2.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
			} else if (atMoreIndented) {
				atMoreIndented = false;
				state.result += common2.repeat("\n", emptyLines + 1);
			} else if (emptyLines === 0) {
				if (didReadContent) state.result += " ";
			} else state.result += common2.repeat("\n", emptyLines);
			else state.result += common2.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
			didReadContent = true;
			detectedIndent = true;
			emptyLines = 0;
			const captureStart = state.position;
			while (!isEol(ch) && ch !== 0) ch = state.input.charCodeAt(++state.position);
			captureSegment(state, captureStart, state.position, false);
		}
		return true;
	}
	function readBlockSequence(state, nodeIndent) {
		const _tag = state.tag;
		const _anchor = state.anchor;
		const _result = [];
		let detected = false;
		if (state.firstTabInLine !== -1) return false;
		if (state.anchor !== null) storeAnchor(state, state.anchor, _result);
		let ch = state.input.charCodeAt(state.position);
		while (ch !== 0) {
			if (state.firstTabInLine !== -1) {
				state.position = state.firstTabInLine;
				throwError(state, "tab characters must not be used in indentation");
			}
			if (ch !== 45) break;
			if (!isWsOrEol(state.input.charCodeAt(state.position + 1))) break;
			detected = true;
			state.position++;
			if (skipSeparationSpace(state, true, -1)) {
				if (state.lineIndent <= nodeIndent) {
					_result.push(null);
					ch = state.input.charCodeAt(state.position);
					continue;
				}
			}
			const _line = state.line;
			composeNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
			_result.push(state.result);
			skipSeparationSpace(state, true, -1);
			ch = state.input.charCodeAt(state.position);
			if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) throwError(state, "bad indentation of a sequence entry");
			else if (state.lineIndent < nodeIndent) break;
		}
		if (detected) {
			state.tag = _tag;
			state.anchor = _anchor;
			state.kind = "sequence";
			state.result = _result;
			return true;
		}
		return false;
	}
	function readBlockMapping(state, nodeIndent, flowIndent) {
		let allowCompact;
		let _keyLine;
		let _keyLineStart;
		let _keyPos;
		const _tag = state.tag;
		const _anchor = state.anchor;
		const _result = {};
		const overridableKeys = /* @__PURE__ */ Object.create(null);
		let keyTag = null;
		let keyNode = null;
		let valueNode = null;
		let atExplicitKey = false;
		let detected = false;
		if (state.firstTabInLine !== -1) return false;
		if (state.anchor !== null) storeAnchor(state, state.anchor, _result);
		let ch = state.input.charCodeAt(state.position);
		while (ch !== 0) {
			if (!atExplicitKey && state.firstTabInLine !== -1) {
				state.position = state.firstTabInLine;
				throwError(state, "tab characters must not be used in indentation");
			}
			const following = state.input.charCodeAt(state.position + 1);
			const _line = state.line;
			if ((ch === 63 || ch === 58) && isWsOrEol(following)) {
				if (ch === 63) {
					if (atExplicitKey) {
						storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
						keyTag = keyNode = valueNode = null;
					}
					detected = true;
					atExplicitKey = true;
					allowCompact = true;
				} else if (atExplicitKey) {
					atExplicitKey = false;
					allowCompact = true;
				} else throwError(state, "incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line");
				state.position += 1;
				ch = following;
			} else {
				_keyLine = state.line;
				_keyLineStart = state.lineStart;
				_keyPos = state.position;
				if (!composeNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) break;
				if (state.line === _line) {
					ch = state.input.charCodeAt(state.position);
					while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
					if (ch === 58) {
						ch = state.input.charCodeAt(++state.position);
						if (!isWsOrEol(ch)) throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
						if (atExplicitKey) {
							storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
							keyTag = keyNode = valueNode = null;
						}
						detected = true;
						atExplicitKey = false;
						allowCompact = false;
						keyTag = state.tag;
						keyNode = state.result;
					} else if (detected) throwError(state, "can not read an implicit mapping pair; a colon is missed");
					else {
						state.tag = _tag;
						state.anchor = _anchor;
						return true;
					}
				} else if (detected) throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
				else {
					state.tag = _tag;
					state.anchor = _anchor;
					return true;
				}
			}
			if (state.line === _line || state.lineIndent > nodeIndent) {
				if (atExplicitKey) {
					_keyLine = state.line;
					_keyLineStart = state.lineStart;
					_keyPos = state.position;
				}
				if (composeNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, allowCompact)) if (atExplicitKey) keyNode = state.result;
				else valueNode = state.result;
				if (!atExplicitKey) {
					storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _keyLine, _keyLineStart, _keyPos);
					keyTag = keyNode = valueNode = null;
				}
				skipSeparationSpace(state, true, -1);
				ch = state.input.charCodeAt(state.position);
			}
			if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) throwError(state, "bad indentation of a mapping entry");
			else if (state.lineIndent < nodeIndent) break;
		}
		if (atExplicitKey) storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
		if (detected) {
			state.tag = _tag;
			state.anchor = _anchor;
			state.kind = "mapping";
			state.result = _result;
		}
		return detected;
	}
	function readTagProperty(state) {
		let isVerbatim = false;
		let isNamed = false;
		let tagHandle;
		let tagName;
		let ch = state.input.charCodeAt(state.position);
		if (ch !== 33) return false;
		if (state.tag !== null) throwError(state, "duplication of a tag property");
		ch = state.input.charCodeAt(++state.position);
		if (ch === 60) {
			isVerbatim = true;
			ch = state.input.charCodeAt(++state.position);
		} else if (ch === 33) {
			isNamed = true;
			tagHandle = "!!";
			ch = state.input.charCodeAt(++state.position);
		} else tagHandle = "!";
		let _position = state.position;
		if (isVerbatim) {
			do
				ch = state.input.charCodeAt(++state.position);
			while (ch !== 0 && ch !== 62);
			if (state.position < state.length) {
				tagName = state.input.slice(_position, state.position);
				ch = state.input.charCodeAt(++state.position);
			} else throwError(state, "unexpected end of the stream within a verbatim tag");
		} else {
			while (ch !== 0 && !isWsOrEol(ch)) {
				if (ch === 33) if (!isNamed) {
					tagHandle = state.input.slice(_position - 1, state.position + 1);
					if (!PATTERN_TAG_HANDLE.test(tagHandle)) throwError(state, "named tag handle cannot contain such characters");
					isNamed = true;
					_position = state.position + 1;
				} else throwError(state, "tag suffix cannot contain exclamation marks");
				ch = state.input.charCodeAt(++state.position);
			}
			tagName = state.input.slice(_position, state.position);
			if (PATTERN_FLOW_INDICATORS.test(tagName)) throwError(state, "tag suffix cannot contain flow indicator characters");
		}
		if (tagName && !PATTERN_TAG_URI.test(tagName)) throwError(state, "tag name cannot contain such characters: " + tagName);
		try {
			tagName = decodeURIComponent(tagName);
		} catch (err) {
			throwError(state, "tag name is malformed: " + tagName);
		}
		if (isVerbatim) state.tag = tagName;
		else if (_hasOwnProperty.call(state.tagMap, tagHandle)) state.tag = state.tagMap[tagHandle] + tagName;
		else if (tagHandle === "!") state.tag = "!" + tagName;
		else if (tagHandle === "!!") state.tag = "tag:yaml.org,2002:" + tagName;
		else throwError(state, "undeclared tag handle \"" + tagHandle + "\"");
		return true;
	}
	function readAnchorProperty(state) {
		let ch = state.input.charCodeAt(state.position);
		if (ch !== 38) return false;
		if (state.anchor !== null) throwError(state, "duplication of an anchor property");
		ch = state.input.charCodeAt(++state.position);
		const _position = state.position;
		while (ch !== 0 && !isWsOrEol(ch) && !isFlowIndicator(ch)) ch = state.input.charCodeAt(++state.position);
		if (state.position === _position) throwError(state, "name of an anchor node must contain at least one character");
		state.anchor = state.input.slice(_position, state.position);
		return true;
	}
	function readAlias(state) {
		let ch = state.input.charCodeAt(state.position);
		if (ch !== 42) return false;
		ch = state.input.charCodeAt(++state.position);
		const _position = state.position;
		while (ch !== 0 && !isWsOrEol(ch) && !isFlowIndicator(ch)) ch = state.input.charCodeAt(++state.position);
		if (state.position === _position) throwError(state, "name of an alias node must contain at least one character");
		const alias = state.input.slice(_position, state.position);
		if (!_hasOwnProperty.call(state.anchorMap, alias)) throwError(state, "unidentified alias \"" + alias + "\"");
		state.result = state.anchorMap[alias];
		skipSeparationSpace(state, true, -1);
		return true;
	}
	function tryReadBlockMappingFromProperty(state, propertyStart, nodeIndent, flowIndent) {
		const fallbackState = snapshotState(state);
		beginAnchorTransaction(state);
		restoreState(state, propertyStart);
		state.tag = null;
		state.anchor = null;
		state.kind = null;
		state.result = null;
		if (readBlockMapping(state, nodeIndent, flowIndent) && state.kind === "mapping") {
			commitAnchorTransaction(state);
			return true;
		}
		rollbackAnchorTransaction(state);
		restoreState(state, fallbackState);
		return false;
	}
	function composeNode(state, parentIndent, nodeContext, allowToSeek, allowCompact) {
		let allowBlockScalars;
		let allowBlockCollections;
		let indentStatus = 1;
		let atNewLine = false;
		let hasContent = false;
		let propertyStart = null;
		let type2;
		let flowIndent;
		let blockIndent;
		if (state.depth >= state.maxDepth) throwError(state, "nesting exceeded maxDepth (" + state.maxDepth + ")");
		state.depth += 1;
		if (state.listener !== null) state.listener("open", state);
		state.tag = null;
		state.anchor = null;
		state.kind = null;
		state.result = null;
		const allowBlockStyles = allowBlockScalars = allowBlockCollections = CONTEXT_BLOCK_OUT === nodeContext || CONTEXT_BLOCK_IN === nodeContext;
		if (allowToSeek) {
			if (skipSeparationSpace(state, true, -1)) {
				atNewLine = true;
				if (state.lineIndent > parentIndent) indentStatus = 1;
				else if (state.lineIndent === parentIndent) indentStatus = 0;
				else if (state.lineIndent < parentIndent) indentStatus = -1;
			}
		}
		if (indentStatus === 1) while (true) {
			const ch = state.input.charCodeAt(state.position);
			const propertyState = snapshotState(state);
			if (atNewLine && (ch === 33 && state.tag !== null || ch === 38 && state.anchor !== null)) break;
			if (!readTagProperty(state) && !readAnchorProperty(state)) break;
			if (propertyStart === null) propertyStart = propertyState;
			if (skipSeparationSpace(state, true, -1)) {
				atNewLine = true;
				allowBlockCollections = allowBlockStyles;
				if (state.lineIndent > parentIndent) indentStatus = 1;
				else if (state.lineIndent === parentIndent) indentStatus = 0;
				else if (state.lineIndent < parentIndent) indentStatus = -1;
			} else allowBlockCollections = false;
		}
		if (allowBlockCollections) allowBlockCollections = atNewLine || allowCompact;
		if (indentStatus === 1 || CONTEXT_BLOCK_OUT === nodeContext) {
			if (CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext) flowIndent = parentIndent;
			else flowIndent = parentIndent + 1;
			blockIndent = state.position - state.lineStart;
			if (indentStatus === 1) if (allowBlockCollections && (readBlockSequence(state, blockIndent) || readBlockMapping(state, blockIndent, flowIndent)) || readFlowCollection(state, flowIndent)) hasContent = true;
			else {
				const ch = state.input.charCodeAt(state.position);
				if (propertyStart !== null && allowBlockStyles && !allowBlockCollections && ch !== 124 && ch !== 62 && tryReadBlockMappingFromProperty(state, propertyStart, propertyStart.position - propertyStart.lineStart, flowIndent)) hasContent = true;
				else if (allowBlockScalars && readBlockScalar(state, flowIndent) || readSingleQuotedScalar(state, flowIndent) || readDoubleQuotedScalar(state, flowIndent)) hasContent = true;
				else if (readAlias(state)) {
					hasContent = true;
					if (state.tag !== null || state.anchor !== null) throwError(state, "alias node should not have any properties");
				} else if (readPlainScalar(state, flowIndent, CONTEXT_FLOW_IN === nodeContext)) {
					hasContent = true;
					if (state.tag === null) state.tag = "?";
				}
				if (state.anchor !== null) storeAnchor(state, state.anchor, state.result);
			}
			else if (indentStatus === 0) hasContent = allowBlockCollections && readBlockSequence(state, blockIndent);
		}
		if (state.tag === null) {
			if (state.anchor !== null) storeAnchor(state, state.anchor, state.result);
		} else if (state.tag === "?") {
			if (state.result !== null && state.kind !== "scalar") throwError(state, "unacceptable node kind for !<?> tag; it should be \"scalar\", not \"" + state.kind + "\"");
			for (let typeIndex = 0, typeQuantity = state.implicitTypes.length; typeIndex < typeQuantity; typeIndex += 1) {
				type2 = state.implicitTypes[typeIndex];
				if (type2.resolve(state.result)) {
					state.result = type2.construct(state.result);
					state.tag = type2.tag;
					if (state.anchor !== null) storeAnchor(state, state.anchor, state.result);
					break;
				}
			}
		} else if (state.tag !== "!") {
			if (_hasOwnProperty.call(state.typeMap[state.kind || "fallback"], state.tag)) type2 = state.typeMap[state.kind || "fallback"][state.tag];
			else {
				type2 = null;
				const typeList = state.typeMap.multi[state.kind || "fallback"];
				for (let typeIndex = 0, typeQuantity = typeList.length; typeIndex < typeQuantity; typeIndex += 1) if (state.tag.slice(0, typeList[typeIndex].tag.length) === typeList[typeIndex].tag) {
					type2 = typeList[typeIndex];
					break;
				}
			}
			if (!type2) throwError(state, "unknown tag !<" + state.tag + ">");
			if (state.result !== null && type2.kind !== state.kind) throwError(state, "unacceptable node kind for !<" + state.tag + "> tag; it should be \"" + type2.kind + "\", not \"" + state.kind + "\"");
			if (!type2.resolve(state.result, state.tag)) throwError(state, "cannot resolve a node with !<" + state.tag + "> explicit tag");
			else {
				state.result = type2.construct(state.result, state.tag);
				if (state.anchor !== null) storeAnchor(state, state.anchor, state.result);
			}
		}
		if (state.listener !== null) state.listener("close", state);
		state.depth -= 1;
		return state.tag !== null || state.anchor !== null || hasContent;
	}
	function readDocument(state) {
		const documentStart = state.position;
		let hasDirectives = false;
		let ch;
		state.version = null;
		state.checkLineBreaks = state.legacy;
		state.tagMap = /* @__PURE__ */ Object.create(null);
		state.anchorMap = /* @__PURE__ */ Object.create(null);
		while ((ch = state.input.charCodeAt(state.position)) !== 0) {
			skipSeparationSpace(state, true, -1);
			ch = state.input.charCodeAt(state.position);
			if (state.lineIndent > 0 || ch !== 37) break;
			hasDirectives = true;
			ch = state.input.charCodeAt(++state.position);
			let _position = state.position;
			while (ch !== 0 && !isWsOrEol(ch)) ch = state.input.charCodeAt(++state.position);
			const directiveName = state.input.slice(_position, state.position);
			const directiveArgs = [];
			if (directiveName.length < 1) throwError(state, "directive name must not be less than one character in length");
			while (ch !== 0) {
				while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
				if (ch === 35) {
					do
						ch = state.input.charCodeAt(++state.position);
					while (ch !== 0 && !isEol(ch));
					break;
				}
				if (isEol(ch)) break;
				_position = state.position;
				while (ch !== 0 && !isWsOrEol(ch)) ch = state.input.charCodeAt(++state.position);
				directiveArgs.push(state.input.slice(_position, state.position));
			}
			if (ch !== 0) readLineBreak(state);
			if (_hasOwnProperty.call(directiveHandlers, directiveName)) directiveHandlers[directiveName](state, directiveName, directiveArgs);
			else throwWarning(state, "unknown document directive \"" + directiveName + "\"");
		}
		skipSeparationSpace(state, true, -1);
		if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45) {
			state.position += 3;
			skipSeparationSpace(state, true, -1);
		} else if (hasDirectives) throwError(state, "directives end mark is expected");
		composeNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, true);
		skipSeparationSpace(state, true, -1);
		if (state.checkLineBreaks && PATTERN_NON_ASCII_LINE_BREAKS.test(state.input.slice(documentStart, state.position))) throwWarning(state, "non-ASCII line breaks are interpreted as content");
		state.documents.push(state.result);
		if (state.position === state.lineStart && testDocumentSeparator(state)) {
			if (state.input.charCodeAt(state.position) === 46) {
				state.position += 3;
				skipSeparationSpace(state, true, -1);
			}
			return;
		}
		if (state.position < state.length - 1) throwError(state, "end of the stream or a document separator is expected");
	}
	function loadDocuments(input, options) {
		input = String(input);
		options = options || {};
		if (input.length !== 0) {
			if (input.charCodeAt(input.length - 1) !== 10 && input.charCodeAt(input.length - 1) !== 13) input += "\n";
			if (input.charCodeAt(0) === 65279) input = input.slice(1);
		}
		const state = new State(input, options);
		const nullpos = input.indexOf("\0");
		if (nullpos !== -1) {
			state.position = nullpos;
			throwError(state, "null byte is not allowed in input");
		}
		state.input += "\0";
		while (state.input.charCodeAt(state.position) === 32) {
			state.lineIndent += 1;
			state.position += 1;
		}
		while (state.position < state.length - 1) readDocument(state);
		return state.documents;
	}
	function loadAll2(input, iterator, options) {
		if (iterator !== null && typeof iterator === "object" && typeof options === "undefined") {
			options = iterator;
			iterator = null;
		}
		const documents = loadDocuments(input, options);
		if (typeof iterator !== "function") return documents;
		for (let index = 0, length = documents.length; index < length; index += 1) iterator(documents[index]);
	}
	function load2(input, options) {
		const documents = loadDocuments(input, options);
		if (documents.length === 0) return;
		else if (documents.length === 1) return documents[0];
		throw new YAMLException2("expected a single document in the stream, but found more");
	}
	loader.loadAll = loadAll2;
	loader.load = load2;
	return loader;
}
var dumper = {};
var hasRequiredDumper;
function requireDumper() {
	if (hasRequiredDumper) return dumper;
	hasRequiredDumper = 1;
	const common2 = requireCommon();
	const YAMLException2 = requireException();
	const DEFAULT_SCHEMA2 = require_default();
	const _toString = Object.prototype.toString;
	const _hasOwnProperty = Object.prototype.hasOwnProperty;
	const CHAR_BOM = 65279;
	const CHAR_TAB = 9;
	const CHAR_LINE_FEED = 10;
	const CHAR_CARRIAGE_RETURN = 13;
	const CHAR_SPACE = 32;
	const CHAR_EXCLAMATION = 33;
	const CHAR_DOUBLE_QUOTE = 34;
	const CHAR_SHARP = 35;
	const CHAR_PERCENT = 37;
	const CHAR_AMPERSAND = 38;
	const CHAR_SINGLE_QUOTE = 39;
	const CHAR_ASTERISK = 42;
	const CHAR_COMMA = 44;
	const CHAR_MINUS = 45;
	const CHAR_COLON = 58;
	const CHAR_EQUALS = 61;
	const CHAR_GREATER_THAN = 62;
	const CHAR_QUESTION = 63;
	const CHAR_COMMERCIAL_AT = 64;
	const CHAR_LEFT_SQUARE_BRACKET = 91;
	const CHAR_RIGHT_SQUARE_BRACKET = 93;
	const CHAR_GRAVE_ACCENT = 96;
	const CHAR_LEFT_CURLY_BRACKET = 123;
	const CHAR_VERTICAL_LINE = 124;
	const CHAR_RIGHT_CURLY_BRACKET = 125;
	const ESCAPE_SEQUENCES = {};
	ESCAPE_SEQUENCES[0] = "\\0";
	ESCAPE_SEQUENCES[7] = "\\a";
	ESCAPE_SEQUENCES[8] = "\\b";
	ESCAPE_SEQUENCES[9] = "\\t";
	ESCAPE_SEQUENCES[10] = "\\n";
	ESCAPE_SEQUENCES[11] = "\\v";
	ESCAPE_SEQUENCES[12] = "\\f";
	ESCAPE_SEQUENCES[13] = "\\r";
	ESCAPE_SEQUENCES[27] = "\\e";
	ESCAPE_SEQUENCES[34] = "\\\"";
	ESCAPE_SEQUENCES[92] = "\\\\";
	ESCAPE_SEQUENCES[133] = "\\N";
	ESCAPE_SEQUENCES[160] = "\\_";
	ESCAPE_SEQUENCES[8232] = "\\L";
	ESCAPE_SEQUENCES[8233] = "\\P";
	const DEPRECATED_BOOLEANS_SYNTAX = [
		"y",
		"Y",
		"yes",
		"Yes",
		"YES",
		"on",
		"On",
		"ON",
		"n",
		"N",
		"no",
		"No",
		"NO",
		"off",
		"Off",
		"OFF"
	];
	const DEPRECATED_BASE60_SYNTAX = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/;
	function compileStyleMap(schema2, map2) {
		if (map2 === null) return {};
		const result = {};
		const keys = Object.keys(map2);
		for (let index = 0, length = keys.length; index < length; index += 1) {
			let tag = keys[index];
			let style = String(map2[tag]);
			if (tag.slice(0, 2) === "!!") tag = "tag:yaml.org,2002:" + tag.slice(2);
			const type2 = schema2.compiledTypeMap["fallback"][tag];
			if (type2 && _hasOwnProperty.call(type2.styleAliases, style)) style = type2.styleAliases[style];
			result[tag] = style;
		}
		return result;
	}
	function encodeHex(character) {
		let handle;
		let length;
		const string = character.toString(16).toUpperCase();
		if (character <= 255) {
			handle = "x";
			length = 2;
		} else if (character <= 65535) {
			handle = "u";
			length = 4;
		} else if (character <= 4294967295) {
			handle = "U";
			length = 8;
		} else throw new YAMLException2("code point within a string may not be greater than 0xFFFFFFFF");
		return "\\" + handle + common2.repeat("0", length - string.length) + string;
	}
	const QUOTING_TYPE_SINGLE = 1;
	const QUOTING_TYPE_DOUBLE = 2;
	function State(options) {
		this.schema = options["schema"] || DEFAULT_SCHEMA2;
		this.indent = Math.max(1, options["indent"] || 2);
		this.noArrayIndent = options["noArrayIndent"] || false;
		this.skipInvalid = options["skipInvalid"] || false;
		this.flowLevel = common2.isNothing(options["flowLevel"]) ? -1 : options["flowLevel"];
		this.styleMap = compileStyleMap(this.schema, options["styles"] || null);
		this.sortKeys = options["sortKeys"] || false;
		this.lineWidth = options["lineWidth"] || 80;
		this.noRefs = options["noRefs"] || false;
		this.noCompatMode = options["noCompatMode"] || false;
		this.condenseFlow = options["condenseFlow"] || false;
		this.quotingType = options["quotingType"] === "\"" ? QUOTING_TYPE_DOUBLE : QUOTING_TYPE_SINGLE;
		this.forceQuotes = options["forceQuotes"] || false;
		this.replacer = typeof options["replacer"] === "function" ? options["replacer"] : null;
		this.implicitTypes = this.schema.compiledImplicit;
		this.explicitTypes = this.schema.compiledExplicit;
		this.tag = null;
		this.result = "";
		this.duplicates = [];
		this.usedDuplicates = null;
	}
	function indentString(string, spaces) {
		const ind = common2.repeat(" ", spaces);
		let position = 0;
		let result = "";
		const length = string.length;
		while (position < length) {
			let line;
			const next = string.indexOf("\n", position);
			if (next === -1) {
				line = string.slice(position);
				position = length;
			} else {
				line = string.slice(position, next + 1);
				position = next + 1;
			}
			if (line.length && line !== "\n") result += ind;
			result += line;
		}
		return result;
	}
	function generateNextLine(state, level) {
		return "\n" + common2.repeat(" ", state.indent * level);
	}
	function testImplicitResolving(state, str2) {
		for (let index = 0, length = state.implicitTypes.length; index < length; index += 1) if (state.implicitTypes[index].resolve(str2)) return true;
		return false;
	}
	function isWhitespace(c) {
		return c === CHAR_SPACE || c === CHAR_TAB;
	}
	function isPrintable(c) {
		return c >= 32 && c <= 126 || c >= 161 && c <= 55295 && c !== 8232 && c !== 8233 || c >= 57344 && c <= 65533 && c !== CHAR_BOM || c >= 65536 && c <= 1114111;
	}
	function isNsCharOrWhitespace(c) {
		return isPrintable(c) && c !== CHAR_BOM && c !== CHAR_CARRIAGE_RETURN && c !== CHAR_LINE_FEED;
	}
	function isPlainSafe(c, prev, inblock) {
		const cIsNsCharOrWhitespace = isNsCharOrWhitespace(c);
		const cIsNsChar = cIsNsCharOrWhitespace && !isWhitespace(c);
		return (inblock ? cIsNsCharOrWhitespace : cIsNsCharOrWhitespace && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET) && c !== CHAR_SHARP && !(prev === CHAR_COLON && !cIsNsChar) || isNsCharOrWhitespace(prev) && !isWhitespace(prev) && c === CHAR_SHARP || prev === CHAR_COLON && cIsNsChar;
	}
	function isPlainSafeFirst(c) {
		return isPrintable(c) && c !== CHAR_BOM && !isWhitespace(c) && c !== CHAR_MINUS && c !== CHAR_QUESTION && c !== CHAR_COLON && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET && c !== CHAR_SHARP && c !== CHAR_AMPERSAND && c !== CHAR_ASTERISK && c !== CHAR_EXCLAMATION && c !== CHAR_VERTICAL_LINE && c !== CHAR_EQUALS && c !== CHAR_GREATER_THAN && c !== CHAR_SINGLE_QUOTE && c !== CHAR_DOUBLE_QUOTE && c !== CHAR_PERCENT && c !== CHAR_COMMERCIAL_AT && c !== CHAR_GRAVE_ACCENT;
	}
	function isPlainSafeLast(c) {
		return !isWhitespace(c) && c !== CHAR_COLON;
	}
	function codePointAt(string, pos) {
		const first = string.charCodeAt(pos);
		let second;
		if (first >= 55296 && first <= 56319 && pos + 1 < string.length) {
			second = string.charCodeAt(pos + 1);
			if (second >= 56320 && second <= 57343) return (first - 55296) * 1024 + second - 56320 + 65536;
		}
		return first;
	}
	function needIndentIndicator(string) {
		return /^\n* /.test(string);
	}
	const STYLE_PLAIN = 1;
	const STYLE_SINGLE = 2;
	const STYLE_LITERAL = 3;
	const STYLE_FOLDED = 4;
	const STYLE_DOUBLE = 5;
	function chooseScalarStyle(string, singleLineOnly, indentPerLevel, lineWidth, testAmbiguousType, quotingType, forceQuotes, inblock) {
		let i;
		let char = 0;
		let prevChar = null;
		let hasLineBreak = false;
		let hasFoldableLine = false;
		const shouldTrackWidth = lineWidth !== -1;
		let previousLineBreak = -1;
		let plain = isPlainSafeFirst(codePointAt(string, 0)) && isPlainSafeLast(codePointAt(string, string.length - 1));
		if (singleLineOnly || forceQuotes) for (i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
			char = codePointAt(string, i);
			if (!isPrintable(char)) return STYLE_DOUBLE;
			plain = plain && isPlainSafe(char, prevChar, inblock);
			prevChar = char;
		}
		else {
			for (i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
				char = codePointAt(string, i);
				if (char === CHAR_LINE_FEED) {
					hasLineBreak = true;
					if (shouldTrackWidth) {
						hasFoldableLine = hasFoldableLine || i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ";
						previousLineBreak = i;
					}
				} else if (!isPrintable(char)) return STYLE_DOUBLE;
				plain = plain && isPlainSafe(char, prevChar, inblock);
				prevChar = char;
			}
			hasFoldableLine = hasFoldableLine || shouldTrackWidth && i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ";
		}
		if (!hasLineBreak && !hasFoldableLine) {
			if (plain && !forceQuotes && !testAmbiguousType(string)) return STYLE_PLAIN;
			return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
		}
		if (indentPerLevel > 9 && needIndentIndicator(string)) return STYLE_DOUBLE;
		if (!forceQuotes) return hasFoldableLine ? STYLE_FOLDED : STYLE_LITERAL;
		return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
	}
	function writeScalar(state, string, level, iskey, inblock) {
		state.dump = (function() {
			if (string.length === 0) return state.quotingType === QUOTING_TYPE_DOUBLE ? "\"\"" : "''";
			if (!state.noCompatMode) {
				if (DEPRECATED_BOOLEANS_SYNTAX.indexOf(string) !== -1 || DEPRECATED_BASE60_SYNTAX.test(string)) return state.quotingType === QUOTING_TYPE_DOUBLE ? "\"" + string + "\"" : "'" + string + "'";
			}
			const indent = state.indent * Math.max(1, level);
			const lineWidth = state.lineWidth === -1 ? -1 : Math.max(Math.min(state.lineWidth, 40), state.lineWidth - indent);
			const singleLineOnly = iskey || state.flowLevel > -1 && level >= state.flowLevel;
			function testAmbiguity(string2) {
				return testImplicitResolving(state, string2);
			}
			switch (chooseScalarStyle(string, singleLineOnly, state.indent, lineWidth, testAmbiguity, state.quotingType, state.forceQuotes && !iskey, inblock)) {
				case STYLE_PLAIN: return string;
				case STYLE_SINGLE: return "'" + string.replace(/'/g, "''") + "'";
				case STYLE_LITERAL: return "|" + blockHeader(string, state.indent) + dropEndingNewline(indentString(string, indent));
				case STYLE_FOLDED: return ">" + blockHeader(string, state.indent) + dropEndingNewline(indentString(foldString(string, lineWidth), indent));
				case STYLE_DOUBLE: return "\"" + escapeString(string) + "\"";
				default: throw new YAMLException2("impossible error: invalid scalar style");
			}
		})();
	}
	function blockHeader(string, indentPerLevel) {
		const indentIndicator = needIndentIndicator(string) ? String(indentPerLevel) : "";
		const clip = string[string.length - 1] === "\n";
		return indentIndicator + (clip && (string[string.length - 2] === "\n" || string === "\n") ? "+" : clip ? "" : "-") + "\n";
	}
	function dropEndingNewline(string) {
		return string[string.length - 1] === "\n" ? string.slice(0, -1) : string;
	}
	function foldString(string, width) {
		const lineRe = /(\n+)([^\n]*)/g;
		let result = (function() {
			let nextLF = string.indexOf("\n");
			nextLF = nextLF !== -1 ? nextLF : string.length;
			lineRe.lastIndex = nextLF;
			return foldLine(string.slice(0, nextLF), width);
		})();
		let prevMoreIndented = string[0] === "\n" || string[0] === " ";
		let moreIndented;
		let match;
		while (match = lineRe.exec(string)) {
			const prefix = match[1];
			const line = match[2];
			moreIndented = line[0] === " ";
			result += prefix + (!prevMoreIndented && !moreIndented && line !== "" ? "\n" : "") + foldLine(line, width);
			prevMoreIndented = moreIndented;
		}
		return result;
	}
	function foldLine(line, width) {
		if (line === "" || line[0] === " ") return line;
		const breakRe = / [^ ]/g;
		let match;
		let start = 0;
		let end;
		let curr = 0;
		let next = 0;
		let result = "";
		while (match = breakRe.exec(line)) {
			next = match.index;
			if (next - start > width) {
				end = curr > start ? curr : next;
				result += "\n" + line.slice(start, end);
				start = end + 1;
			}
			curr = next;
		}
		result += "\n";
		if (line.length - start > width && curr > start) result += line.slice(start, curr) + "\n" + line.slice(curr + 1);
		else result += line.slice(start);
		return result.slice(1);
	}
	function escapeString(string) {
		let result = "";
		let char = 0;
		for (let i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
			char = codePointAt(string, i);
			const escapeSeq = ESCAPE_SEQUENCES[char];
			if (!escapeSeq && isPrintable(char)) {
				result += string[i];
				if (char >= 65536) result += string[i + 1];
			} else result += escapeSeq || encodeHex(char);
		}
		return result;
	}
	function writeFlowSequence(state, level, object) {
		let _result = "";
		const _tag = state.tag;
		for (let index = 0, length = object.length; index < length; index += 1) {
			let value = object[index];
			if (state.replacer) value = state.replacer.call(object, String(index), value);
			if (writeNode(state, level, value, false, false) || typeof value === "undefined" && writeNode(state, level, null, false, false)) {
				if (_result !== "") _result += "," + (!state.condenseFlow ? " " : "");
				_result += state.dump;
			}
		}
		state.tag = _tag;
		state.dump = "[" + _result + "]";
	}
	function writeBlockSequence(state, level, object, compact) {
		let _result = "";
		const _tag = state.tag;
		for (let index = 0, length = object.length; index < length; index += 1) {
			let value = object[index];
			if (state.replacer) value = state.replacer.call(object, String(index), value);
			if (writeNode(state, level + 1, value, true, true, false, true) || typeof value === "undefined" && writeNode(state, level + 1, null, true, true, false, true)) {
				if (!compact || _result !== "") _result += generateNextLine(state, level);
				if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) _result += "-";
				else _result += "- ";
				_result += state.dump;
			}
		}
		state.tag = _tag;
		state.dump = _result || "[]";
	}
	function writeFlowMapping(state, level, object) {
		let _result = "";
		const _tag = state.tag;
		const objectKeyList = Object.keys(object);
		for (let index = 0, length = objectKeyList.length; index < length; index += 1) {
			let pairBuffer = "";
			if (_result !== "") pairBuffer += ", ";
			if (state.condenseFlow) pairBuffer += "\"";
			const objectKey = objectKeyList[index];
			let objectValue = object[objectKey];
			if (state.replacer) objectValue = state.replacer.call(object, objectKey, objectValue);
			if (!writeNode(state, level, objectKey, false, false)) continue;
			if (state.dump.length > 1024) pairBuffer += "? ";
			pairBuffer += state.dump + (state.condenseFlow ? "\"" : "") + ":" + (state.condenseFlow ? "" : " ");
			if (!writeNode(state, level, objectValue, false, false)) continue;
			pairBuffer += state.dump;
			_result += pairBuffer;
		}
		state.tag = _tag;
		state.dump = "{" + _result + "}";
	}
	function writeBlockMapping(state, level, object, compact) {
		let _result = "";
		const _tag = state.tag;
		const objectKeyList = Object.keys(object);
		if (state.sortKeys === true) objectKeyList.sort();
		else if (typeof state.sortKeys === "function") objectKeyList.sort(state.sortKeys);
		else if (state.sortKeys) throw new YAMLException2("sortKeys must be a boolean or a function");
		for (let index = 0, length = objectKeyList.length; index < length; index += 1) {
			let pairBuffer = "";
			if (!compact || _result !== "") pairBuffer += generateNextLine(state, level);
			const objectKey = objectKeyList[index];
			let objectValue = object[objectKey];
			if (state.replacer) objectValue = state.replacer.call(object, objectKey, objectValue);
			if (!writeNode(state, level + 1, objectKey, true, true, true)) continue;
			const explicitPair = state.tag !== null && state.tag !== "?" || state.dump && state.dump.length > 1024;
			if (explicitPair) if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) pairBuffer += "?";
			else pairBuffer += "? ";
			pairBuffer += state.dump;
			if (explicitPair) pairBuffer += generateNextLine(state, level);
			if (!writeNode(state, level + 1, objectValue, true, explicitPair)) continue;
			if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) pairBuffer += ":";
			else pairBuffer += ": ";
			pairBuffer += state.dump;
			_result += pairBuffer;
		}
		state.tag = _tag;
		state.dump = _result || "{}";
	}
	function detectType(state, object, explicit) {
		const typeList = explicit ? state.explicitTypes : state.implicitTypes;
		for (let index = 0, length = typeList.length; index < length; index += 1) {
			const type2 = typeList[index];
			if ((type2.instanceOf || type2.predicate) && (!type2.instanceOf || typeof object === "object" && object instanceof type2.instanceOf) && (!type2.predicate || type2.predicate(object))) {
				if (explicit) if (type2.multi && type2.representName) state.tag = type2.representName(object);
				else state.tag = type2.tag;
				else state.tag = "?";
				if (type2.represent) {
					const style = state.styleMap[type2.tag] || type2.defaultStyle;
					let _result;
					if (_toString.call(type2.represent) === "[object Function]") _result = type2.represent(object, style);
					else if (_hasOwnProperty.call(type2.represent, style)) _result = type2.represent[style](object, style);
					else throw new YAMLException2("!<" + type2.tag + "> tag resolver accepts not \"" + style + "\" style");
					state.dump = _result;
				}
				return true;
			}
		}
		return false;
	}
	function writeNode(state, level, object, block, compact, iskey, isblockseq) {
		state.tag = null;
		state.dump = object;
		if (!detectType(state, object, false)) detectType(state, object, true);
		const type2 = _toString.call(state.dump);
		const inblock = block;
		if (block) block = state.flowLevel < 0 || state.flowLevel > level;
		const objectOrArray = type2 === "[object Object]" || type2 === "[object Array]";
		let duplicateIndex;
		let duplicate;
		if (objectOrArray) {
			duplicateIndex = state.duplicates.indexOf(object);
			duplicate = duplicateIndex !== -1;
		}
		if (state.tag !== null && state.tag !== "?" || duplicate || state.indent !== 2 && level > 0) compact = false;
		if (duplicate && state.usedDuplicates[duplicateIndex]) state.dump = "*ref_" + duplicateIndex;
		else {
			if (objectOrArray && duplicate && !state.usedDuplicates[duplicateIndex]) state.usedDuplicates[duplicateIndex] = true;
			if (type2 === "[object Object]") if (block && Object.keys(state.dump).length !== 0) {
				writeBlockMapping(state, level, state.dump, compact);
				if (duplicate) state.dump = "&ref_" + duplicateIndex + state.dump;
			} else {
				writeFlowMapping(state, level, state.dump);
				if (duplicate) state.dump = "&ref_" + duplicateIndex + " " + state.dump;
			}
			else if (type2 === "[object Array]") if (block && state.dump.length !== 0) {
				if (state.noArrayIndent && !isblockseq && level > 0) writeBlockSequence(state, level - 1, state.dump, compact);
				else writeBlockSequence(state, level, state.dump, compact);
				if (duplicate) state.dump = "&ref_" + duplicateIndex + state.dump;
			} else {
				writeFlowSequence(state, level, state.dump);
				if (duplicate) state.dump = "&ref_" + duplicateIndex + " " + state.dump;
			}
			else if (type2 === "[object String]") {
				if (state.tag !== "?") writeScalar(state, state.dump, level, iskey, inblock);
			} else if (type2 === "[object Undefined]") return false;
			else {
				if (state.skipInvalid) return false;
				throw new YAMLException2("unacceptable kind of an object to dump " + type2);
			}
			if (state.tag !== null && state.tag !== "?") {
				let tagStr = encodeURI(state.tag[0] === "!" ? state.tag.slice(1) : state.tag).replace(/!/g, "%21");
				if (state.tag[0] === "!") tagStr = "!" + tagStr;
				else if (tagStr.slice(0, 18) === "tag:yaml.org,2002:") tagStr = "!!" + tagStr.slice(18);
				else tagStr = "!<" + tagStr + ">";
				state.dump = tagStr + " " + state.dump;
			}
		}
		return true;
	}
	function getDuplicateReferences(object, state) {
		const objects = [];
		const duplicatesIndexes = [];
		inspectNode(object, objects, duplicatesIndexes);
		const length = duplicatesIndexes.length;
		for (let index = 0; index < length; index += 1) state.duplicates.push(objects[duplicatesIndexes[index]]);
		state.usedDuplicates = new Array(length);
	}
	function inspectNode(object, objects, duplicatesIndexes) {
		if (object !== null && typeof object === "object") {
			const index = objects.indexOf(object);
			if (index !== -1) {
				if (duplicatesIndexes.indexOf(index) === -1) duplicatesIndexes.push(index);
			} else {
				objects.push(object);
				if (Array.isArray(object)) for (let i = 0, length = object.length; i < length; i += 1) inspectNode(object[i], objects, duplicatesIndexes);
				else {
					const objectKeyList = Object.keys(object);
					for (let i = 0, length = objectKeyList.length; i < length; i += 1) inspectNode(object[objectKeyList[i]], objects, duplicatesIndexes);
				}
			}
		}
	}
	function dump2(input, options) {
		options = options || {};
		const state = new State(options);
		if (!state.noRefs) getDuplicateReferences(input, state);
		let value = input;
		if (state.replacer) value = state.replacer.call({ "": value }, "", value);
		if (writeNode(state, 0, value, true, true)) return state.dump + "\n";
		return "";
	}
	dumper.dump = dump2;
	return dumper;
}
var hasRequiredJsYaml;
function requireJsYaml() {
	if (hasRequiredJsYaml) return jsYaml;
	hasRequiredJsYaml = 1;
	const loader2 = requireLoader();
	const dumper2 = requireDumper();
	function renamed(from, to) {
		return function() {
			throw new Error("Function yaml." + from + " is removed in js-yaml 4. Use yaml." + to + " instead, which is now safe by default.");
		};
	}
	jsYaml.Type = requireType();
	jsYaml.Schema = requireSchema();
	jsYaml.FAILSAFE_SCHEMA = requireFailsafe();
	jsYaml.JSON_SCHEMA = requireJson();
	jsYaml.CORE_SCHEMA = requireCore();
	jsYaml.DEFAULT_SCHEMA = require_default();
	jsYaml.load = loader2.load;
	jsYaml.loadAll = loader2.loadAll;
	jsYaml.dump = dumper2.dump;
	jsYaml.YAMLException = requireException();
	jsYaml.types = {
		binary: requireBinary(),
		float: requireFloat(),
		map: requireMap(),
		null: require_null(),
		pairs: requirePairs(),
		set: requireSet(),
		timestamp: requireTimestamp(),
		bool: requireBool(),
		int: requireInt(),
		merge: requireMerge(),
		omap: requireOmap(),
		seq: requireSeq(),
		str: requireStr()
	};
	jsYaml.safeLoad = renamed("safeLoad", "load");
	jsYaml.safeLoadAll = renamed("safeLoadAll", "loadAll");
	jsYaml.safeDump = renamed("safeDump", "dump");
	return jsYaml;
}
const { Type, Schema, FAILSAFE_SCHEMA, JSON_SCHEMA, CORE_SCHEMA, DEFAULT_SCHEMA, load, loadAll, dump, YAMLException, types: types$1, safeLoad, safeLoadAll, safeDump } = /* @__PURE__ */ getDefaultExportFromCjs(requireJsYaml());
//#endregion
//#region ../../vendor/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable$1(value) {
	return value === null || value === void 0;
}
/** Return true when a value is neither `null` nor `undefined`. */
function isNonNullable(value) {
	return !isNullable$1(value);
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Shared config references used by schema validators and plugin runtimes. */
const write$2 = Symbol.for("cosmokit.volatile.write");
/**
* Identify references across ESM/CJS copies of the shared library.
* @param value - a parsed config value.
* @returns whether the value implements the shared reference protocol.
*/
function isVolatile$1(value) {
	return typeof value === "object" && value !== null && write$2 in value;
}
/**
* Collect config references without descending into their snapshots or opaque objects.
* @internal
* @param value - parsed config; cyclic ordinary fields are visited once per path.
* @returns references and their object-key paths, including an empty path for a root reference.
*/
function volatileEntries(value) {
	const ancestors = /* @__PURE__ */ new Set();
	function visit(value, path) {
		if (isVolatile$1(value)) return [{
			path,
			ref: value
		}];
		if (!value || typeof value !== "object" || ancestors.has(value)) return [];
		if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return [];
		ancestors.add(value);
		try {
			return Object.entries(value).flatMap(([key, child]) => visit(child, [...path, key]));
		} finally {
			ancestors.delete(value);
		}
	}
	return visit(value, []);
}
/**
* Commit an already validated immutable snapshot from another reference.
* @internal
* @param target - the owning plugin's stable reference.
* @param source - a newly parsed candidate reference.
*/
function updateVolatile(target, source) {
	target[write$2](source.get());
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is$1(type, value) {
	if (arguments.length === 1) return (value) => is$1(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike$1(value) {
	return is$1("ArrayBuffer", value) || is$1("SharedArrayBuffer", value);
}
function isArrayBufferSource$1(value) {
	return isArrayBufferLike$1(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary$1;
(function(Binary) {
	Binary.is = isArrayBufferLike$1;
	Binary.isSource = isArrayBufferSource$1;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary.fromHex = fromHex;
})(Binary$1 || (Binary$1 = {}));
Binary$1.fromBase64;
Binary$1.toBase64;
Binary$1.fromHex;
Binary$1.toHex;
/**
* Compare values recursively, treating two volatile references as equal regardless of value.
* Strict comparison distinguishes null/undefined, treats opaque objects by identity,
* compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
* @param a - first value.
* @param b - second value.
* @param strict - whether to require strict data equality outside volatile references.
* @returns whether the values compare equal.
*/
function deepEqual$1(a, b, strict) {
	const ancestors = /* @__PURE__ */ new Set();
	function compare(a, b) {
		if (a === b) return true;
		if (isVolatile$1(a) || isVolatile$1(b)) return isVolatile$1(a) && isVolatile$1(b);
		if (!strict && isNullable$1(a) && isNullable$1(b)) return true;
		if (typeof a !== typeof b || typeof a !== "object" || !a || !b) return false;
		if (ancestors.has(a)) return false;
		function check(test, then) {
			return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
		}
		ancestors.add(a);
		try {
			return check(Array.isArray, (a, b) => {
				if (a.length !== b.length) return false;
				for (let index = 0; index < a.length; index++) if (!compare(a[index], b[index])) return false;
				return true;
			}) ?? check(is$1("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is$1("URL"), (a, b) => a.href === b.href) ?? check(is$1("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike$1, (a, b) => {
				if (a.byteLength !== b.byteLength) return false;
				const viewA = new Uint8Array(a);
				const viewB = new Uint8Array(b);
				for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
				return true;
			}) ?? ((!strict || [a, b].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
				...a,
				...b
			}).every((key) => compare(a[key], b[key])));
		} finally {
			ancestors.delete(a);
		}
	}
	return compare(a, b);
}
/** Time constants plus parsing and formatting helpers. */
var Time$1;
(function(Time) {
	Time.millisecond = 1;
	Time.second = 1e3;
	Time.minute = Time.second * 60;
	Time.hour = Time.minute * 60;
	Time.day = Time.hour * 24;
	Time.week = Time.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
	}
	Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time.minute);
	}
	Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
	}
	Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
		else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
		else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
		else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
		return ms + "ms";
	}
	Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time.template = template;
})(Time$1 || (Time$1 = {}));
//#endregion
//#region ../../vendor/loader/lib/index.js
/** Helpers for locating the current Node internal module loader. */
var ModuleLoader;
(function(ModuleLoader) {
	let _cachedLoader;
	function requireInternal(id) {
		const require = createRequire(import.meta.url);
		if (process.execArgv.includes("--expose-internals")) try {
			return require(id);
		} catch {}
		try {
			return require("node-addon-require-builtin").requireBuiltin(id);
		} catch {}
	}
	/**
	* Locate and classify the running Node internal module loader.
	*
	* The shape is decided by which module-job API the loader owns, never by the
	* Node version: v2 landed in 24.12.0, so a major-version test mistags every
	* 24.0–24.11.1 loader as v2 and makes consumers call `resolveSync` with
	* reversed parameters. Arity is not usable either — `resolveSync` reports 2
	* under both shapes. A loader owning neither API is left unclassified rather
	* than guessed, so consumers take their documented no-internals path.
	* @returns the classified loader, or `undefined` when none is reachable or its shape is unknown.
	*/
	function fromInternal() {
		if (_cachedLoader) return _cachedLoader;
		const [major] = process.versions.node.split(".").map(Number);
		if (major < 22) return;
		const raw = requireInternal("internal/modules/esm/loader")?.getOrInitializeCascadedLoader();
		if (!raw) return;
		const version = typeof raw.getOrCreateModuleJob === "function" ? "v2" : typeof raw.getModuleJobForImport === "function" ? "v1" : void 0;
		if (!version) return;
		return _cachedLoader = Object.assign(raw, { version });
	}
	ModuleLoader.fromInternal = fromInternal;
})(ModuleLoader || (ModuleLoader = {}));
/** Runtime owner for a list of child loader entries. */
var EntryGroup = class {
	ctx;
	tree;
	static key = Symbol.for("cordis.group");
	data = [];
	constructor(ctx, tree) {
		this.ctx = ctx;
		this.tree = tree;
		const entry = ctx.fiber.entry;
		if (entry) entry.subgroup = this;
	}
	get context() {
		return this.ctx;
	}
	async create(options) {
		const id = this.tree.ensureId(options);
		const entry = this.tree.store[id] ??= new Entry(this.ctx.loader);
		entry.parent = this;
		await entry.update(options, true, true);
		return entry.id;
	}
	unlink(options) {
		const config = this.data;
		const index = config.indexOf(options);
		if (index >= 0) config.splice(index, 1);
	}
	remove(id, isDispose = false) {
		const entry = this.tree.store[id];
		if (!entry || entry.parent !== this) return;
		delete this.tree.store[id];
		entry.fiber?.dispose();
		if (!isDispose) this.unlink(entry.options);
		this.context.emit("loader/partial-dispose", entry, entry.options, false);
	}
	async update(config) {
		const oldConfig = this.data;
		this.data = config;
		const oldMap = Object.fromEntries(oldConfig.map((options) => [options.id, options]));
		const newMap = Object.fromEntries(config.map((options) => [options.id ?? Symbol("anonymous"), options]));
		const ids = Reflect.ownKeys({
			...oldMap,
			...newMap
		});
		await Promise.all(ids.map(async (id) => {
			if (newMap[id]) await this.create(newMap[id]).catch((error) => {
				this.ctx.logger.error(error);
			});
			else this.remove(id);
		}));
	}
	stop() {
		for (const options of this.data) this.remove(options.id, true);
	}
};
EntryGroup.key, Service.init;
var __rewriteRelativeImportExtension$1 = function(path, preserveJsx) {
	if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
		return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
	});
	return path;
};
const HELPER_FILES = {
	".gitignore": "# created by cordis automatically\n*\n",
	"resolve.mjs": "export default (specifier) => import.meta.resolve(specifier)\n"
};
const cache = Object.create(null);
/** Nearest ancestor of `dir` that owns a `package.json`, if any. */
function findScope(dir) {
	while (true) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return;
		dir = parent;
	}
}
function resolveScope(baseUrl) {
	if (!baseUrl) return;
	let dir;
	try {
		dir = url.fileURLToPath(new URL(".", baseUrl));
	} catch {
		return;
	}
	return findScope(path.resolve(dir));
}
async function write$1(filename, content) {
	const temp = `${filename}.${process.pid}`;
	await fsPromises.writeFile(temp, content);
	await fsPromises.rename(temp, filename);
}
async function _createResolve(scope) {
	const dir = path.join(scope, ".cordis");
	try {
		await fsPromises.mkdir(dir, { recursive: true });
		for (const [name, content] of Object.entries(HELPER_FILES)) await write$1(path.join(dir, name), content);
	} catch {
		return;
	}
	const helperUrl = url.pathToFileURL(path.join(dir, "resolve.mjs")).href;
	return (await import(__rewriteRelativeImportExtension$1(
		/* @vite-ignore */
		helperUrl
	))).default;
}
/**
* Create or reuse a native ESM resolver anchored in the config project's package scope.
* @param baseUrl Config file URL; absent, non-file or unscoped URLs cannot supply a resolver.
* @returns The project resolver, or undefined when no package scope exists or its helper cannot be written.
*/
async function createResolve(baseUrl) {
	const scope = resolveScope(baseUrl);
	if (!scope) return;
	return await (cache[scope] ??= _createResolve(scope));
}
var __rewriteRelativeImportExtension = function(path, preserveJsx) {
	if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
		return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
	});
	return path;
};
/** The entry and the same-tree members of its group, recursively. */
function members(entry) {
	const { tree } = entry.parent;
	const result = [entry];
	const group = entry.subgroup;
	if (group?.tree !== tree) return result;
	for (const options of group.data) {
		const member = tree.store[options.id];
		if (member?.parent === group) result.push(...members(member));
	}
	return result;
}
/** Mutable tree of loader entries. Persistence is supplied by subclasses. */
var EntryTree = class EntryTree {
	static sep = ":";
	ctx;
	enableLogs;
	root;
	store = Object.create(null);
	constructor(ctx) {
		this.ctx = ctx.extend({ baseUrl: ctx.baseUrl });
		this.root = new EntryGroup(this.ctx, this);
		const entry = this.ctx.fiber.entry;
		if (entry) entry.subtree = this;
	}
	get context() {
		return this.ctx;
	}
	/** Iterate entries in this tree and any nested subtrees. */
	*entries() {
		for (const entry of Object.values(this.store)) {
			yield entry;
			if (!entry.subtree) continue;
			yield* entry.subtree.entries();
		}
	}
	/** Return pending import and lifecycle tasks owned by this tree. */
	getTasks() {
		return [...this.entries()].map((entry) => entry._initTask || entry.fiber?.inertia).filter(isNonNullable);
	}
	/** Wait until this tree has no pending import or lifecycle tasks. */
	async await() {
		while (true) {
			const tasks = this.getTasks();
			if (!tasks.length) return;
			await Promise.allSettled(tasks);
		}
	}
	/**
	* Assign a random tree-local id when `options.id` is absent. Explicit ids
	* may contain `EntryTree.sep`; `resolve()` and `resolveGroup()` cannot
	* address such entries by nested path.
	* @param options - Entry options; a generated id is written to `options.id`.
	* @returns The existing or generated id.
	*/
	ensureId(options) {
		if (!options.id) do
			options.id = Math.random().toString(16).slice(2, 10);
		while (this.store[options.id]);
		return options.id;
	}
	/** Resolve an entry by id, including nested ids separated by `EntryTree.sep`. */
	resolve(id) {
		const parts = id.split(EntryTree.sep);
		let tree = this;
		const final = parts.pop();
		for (const part of parts) {
			tree = tree.store[part]?.subtree;
			if (!tree) throw new Error(`cannot resolve entry ${id}`);
		}
		const entry = tree.store[final];
		if (!entry) throw new Error(`cannot resolve entry ${id}`);
		return entry;
	}
	resolveGroup(id) {
		if (!id) return this.root;
		const entry = this.resolve(id);
		if (!entry.subgroup) throw new Error(`entry ${id} is not a group`);
		return entry.subgroup;
	}
	/** Create an entry in the root group or a nested group. */
	async create(options, parent = null, position = Infinity) {
		const group = this.resolveGroup(parent);
		const id = group.tree.ensureId(options);
		group.data.splice(position, 0, options);
		group.tree.commit({
			id,
			group,
			options
		});
		return group.create(options);
	}
	/** Stop and remove an entry from its parent group. */
	remove(id) {
		const entry = this.resolve(id);
		const group = entry.parent;
		const legacy = entry.options;
		group.remove(legacy.id);
		group.tree.commit({
			id: legacy.id,
			group,
			legacy
		});
	}
	/** Update an entry and optionally move it to another group. */
	async update(id, options, parent, position) {
		const entry = this.resolve(id);
		const source = entry.parent;
		const legacy = { ...entry.options };
		if (parent !== void 0) {
			const target = this.resolveGroup(parent);
			const moved = target.tree === source.tree ? [] : members(entry);
			for (const member of moved) {
				const { id } = member.options;
				if (target.tree.store[id]) throw new Error(`entry ${id} already exists in the target tree`);
			}
			source.unlink(entry.options);
			target.data.splice(position ?? Infinity, 0, entry.options);
			entry.parent = target;
			for (const member of moved) {
				delete source.tree.store[member.options.id];
				target.tree.store[member.options.id] = member;
				if (member.subgroup?.tree === source.tree) member.subgroup.tree = target.tree;
			}
		}
		const task = entry.update(options, false, true);
		if (entry.parent.tree !== source.tree) {
			source.tree.commit({
				id: legacy.id,
				group: source,
				legacy
			});
			entry.parent.tree.commit({
				id: legacy.id,
				group: entry.parent,
				options: entry.options
			});
		} else {
			const from = entry.parent === source ? void 0 : source;
			entry.parent.tree.commit({
				id: legacy.id,
				group: entry.parent,
				from,
				options: entry.options,
				legacy
			});
		}
		return task;
	}
	/** Import a plugin module from a specifier or `cordis:` builtin. */
	import(name, getOuterStack) {
		if (name.startsWith("cordis:")) return this.ctx.loader.builtins[name.slice(7)];
		return composeError(async (info) => {
			info.offset += 3;
			if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {});
			else if (name.startsWith(".")) return await import(__rewriteRelativeImportExtension(
				/* @vite-ignore */
				new URL(name, this.ctx.baseUrl).href
			));
			else {
				const resolve = await createResolve(this.ctx.baseUrl);
				return await import(__rewriteRelativeImportExtension(
					/* @vite-ignore */
					resolve ? resolve(name) : name
				));
			}
		}, getOuterStack);
	}
};
/** Evaluate a JavaScript expression against a loader context scope. */
const evaluate = new Function("ctx", "expr", `
  with (ctx) {
    return eval(expr)
  }
`);
/** Recursively replace YAML `!!js` expression nodes with evaluated values. */
function interpolate(ctx, value) {
	if (isJsExpr(value)) return evaluate(ctx, value.__jsExpr);
	else if (!value || typeof value !== "object") return value;
	else if (Array.isArray(value)) return value.map((item) => interpolate(ctx, item));
	else return mapValues(value, (item) => interpolate(ctx, item));
}
/** Return true when a value is a serialized loader JavaScript expression. */
function isJsExpr(value) {
	return value instanceof Object && "__jsExpr" in value;
}
function isSchemastery(schema) {
	return schema?.["~standard"].vendor === "schemastery";
}
function isRecord(value) {
	if (!value || typeof value !== "object" || isJsExpr(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function equal(a, b, schema, ancestors) {
	if (schema?.meta?.volatile) return true;
	if (schema?.type !== "object" || !schema.dict || ancestors.has(schema)) return deepEqual$1(a, b, true);
	const left = a ?? schema.meta?.default;
	const right = b ?? schema.meta?.default;
	if (!isRecord(left) || !isRecord(right)) return deepEqual$1(left, right, true);
	const { dict } = schema;
	ancestors.add(schema);
	try {
		return Object.keys({
			...left,
			...right
		}).every((key) => equal(left[key], right[key], Object.hasOwn(dict, key) ? dict[key] : void 0, ancestors));
	} finally {
		ancestors.delete(schema);
	}
}
/**
* Compare two raw configs, treating schema-declared volatile fields at fixed object paths as equal and absent objects as their schema default.
* Schema backedges, expressions, unknown fields and opaque values keep strict raw equality; an absent or non-Schemastery schema compares everything raw.
* @param previous - previous raw config.
* @param next - next raw config.
* @param schema - the plugin's config schema.
* @returns Whether the configs differ at most in volatile fields, without evaluating expressions, validating config or modifying inputs.
* @internal
*/
function equalExceptVolatile(previous, next, schema) {
	return isSchemastery(schema) ? equal(previous, next, schema, /* @__PURE__ */ new Set()) : deepEqual$1(previous, next, true);
}
function takeEntries(object, keys) {
	const result = [];
	for (const key of keys) {
		if (!(key in object)) continue;
		result.push([key, object[key]]);
		delete object[key];
	}
	return result;
}
function sortKeys(object, prepend = ["id", "name"], append = ["config"]) {
	const part1 = takeEntries(object, prepend);
	const part2 = takeEntries(object, append);
	const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b));
	return Object.assign(object, Object.fromEntries([
		...part1,
		...rest,
		...part2
	]));
}
/** One configured plugin node inside an `EntryTree`. */
var Entry = class Entry {
	loader;
	static key = Symbol.for("cordis.entry");
	ctx;
	fiber;
	/** Raw import result before export normalization; HMR updates it after a successful reload. */
	moduleNamespace;
	parent;
	options = {};
	subgroup;
	subtree;
	_initTask;
	constructor(loader) {
		this.loader = loader;
		this.ctx = loader.ctx.extend({ [Entry.key]: this });
		this.context.emit("loader/entry-init", this);
	}
	get context() {
		return this.ctx;
	}
	get id() {
		let id = this.options.id;
		if (this.parent.tree.ctx.fiber.entry) id = this.parent.tree.ctx.fiber.entry.id + EntryTree.sep + id;
		return id;
	}
	/** True when this entry or any owning parent entry is disabled. */
	get disabled() {
		if (this.options.group) return false;
		let entry = this;
		do {
			if (this._resolveDisabled(entry.options)) return true;
			entry = entry.parent.ctx.fiber.entry;
		} while (entry);
		return false;
	}
	/**
	* Effective disabled state: a `!!js` expression evaluates against the loader
	* context. The raw node stays in the options, so write-back keeps the form.
	*/
	_resolveDisabled(options) {
		return isJsExpr(options.disabled) ? Boolean(this.evaluate(options.disabled.__jsExpr)) : Boolean(options.disabled);
	}
	evaluate(expr) {
		return evaluate(this.ctx, expr);
	}
	async _patchContext(diff) {
		await this.context.waterfall("loader/patch-context", this, async () => {
			Object.setPrototypeOf(this.ctx, this.parent.ctx);
			if (this.fiber?.uid && (diff.includes("config") || this.options.group)) {
				const fiber = this.fiber.ctx.fiber;
				for (const name of Object.keys(fiber.inject)) fiber._checkImpl(name);
				await fiber.update(this.options.config, true);
			}
		});
	}
	async refresh() {
		if (this.fiber) return;
		if (this.disabled) return;
		await this.init();
	}
	/** Merge new options, restart as needed, and persist through the parent tree. */
	async update(options, create = false, force = false) {
		const legacy = { ...this.options };
		if (create) this.options = options;
		else for (const [key, value] of Object.entries(options)) if (isNullable$1(value)) delete this.options[key];
		else this.options[key] = value;
		sortKeys(this.options);
		if (this.disabled) {
			await this.fiber?.dispose();
			return;
		}
		if (this.fiber?.uid) {
			const changes = Object.keys({
				...this.options,
				...legacy
			}).filter((key) => !deepEqual$1(this.options[key], legacy[key], key === "config"));
			const volatileOnly = changes.length === 1 && changes[0] === "config" && this.fiber.state === 2 && Object.getPrototypeOf(this.ctx) === this.parent.ctx && equalExceptVolatile(legacy.config, this.options.config, this.fiber.runtime?.Config);
			if (volatileOnly) this.fiber.rawConfig = this.options.config;
			const pending = volatileOnly && this._commitVolatile() ? [] : changes;
			if (!pending.length && !force) return;
			this.context.emit("loader/partial-dispose", this, legacy, true);
			await this._patchContext(pending);
		} else await this.init();
	}
	/**
	* Parse a volatile-only raw config change and commit its values into the running fiber's references.
	* An invalid candidate is logged and leaves the running references unchanged; the raw config stays retained for the next activation.
	* @returns `false` when an ordinary effective value changed, so the caller applies the ordinary update lifecycle.
	*/
	_commitVolatile() {
		const fiber = this.fiber.ctx.fiber;
		const refs = volatileEntries(fiber.effectiveConfig);
		if (!refs.length) return true;
		const raw = this.options.config;
		let candidate;
		try {
			candidate = fiber.resolveConfig(raw);
		} catch (error) {
			this.ctx.logger.warn("volatile config update failed for %C", this.options.id);
			this.ctx.logger.warn(error);
			return true;
		}
		if (!deepEqual$1(fiber.effectiveConfig, candidate, true)) {
			this.ctx.logger.debug("ordinary config values of %C changed with its volatile values; applying the ordinary update", this.options.id);
			return false;
		}
		const paths = refs.flatMap(({ path, ref }) => {
			const source = path.reduce((value, key) => Reflect.get(value, key), candidate);
			if (deepEqual$1(ref.get(), source.get(), true)) return [];
			updateVolatile(ref, source);
			return [path];
		});
		if (!paths.length) return true;
		const self = Object.create(fiber.ctx);
		self[Context.filter] = (owner) => owner.fiber === fiber;
		try {
			fiber.ctx.emit(self, "loader/volatile-update", paths);
		} catch (error) {
			this.ctx.logger.warn(error);
		}
		return true;
	}
	getOuterStack = () => {
		let entry = this;
		const result = [];
		do {
			result.push(`    at ${entry.parent.tree.ctx.baseUrl}#${entry.options.id}`);
			entry = entry.parent.ctx.fiber.entry;
		} while (entry);
		return result;
	};
	/** Import and start the configured plugin if it is not already running. */
	async init() {
		try {
			await (this._initTask ??= this._init());
		} finally {
			this._initTask = void 0;
		}
		this.fiber?.await().catch(() => {}).finally(() => {
			if (this.loader.getTasks().length) return;
			this.ctx.reflect.notify(["loader"]);
		});
	}
	async _init() {
		let moduleNamespace;
		try {
			moduleNamespace = await this.parent.tree.import(this.options.name, this.getOuterStack);
		} catch (error) {
			this.ctx.logger.error(error);
			return;
		}
		const plugin = this.loader.unwrapExports(moduleNamespace);
		await this._patchContext([]);
		this.loader.showLog(this, "apply");
		this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack);
		this.moduleNamespace = moduleNamespace;
	}
};
Service.check;
//#endregion
//#region ../../packages/util/official-bundles/lib/index.js
/** The bundle package names the dsh installation selects, offers, installs on demand, or retires. */
/** The shipped profile templates auto-initialized on first use, by name. */
const PROFILE_TEMPLATES = {
	acp: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] },
	web: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
	headless: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] },
	sdk: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] },
	"sdk-minimal": { bundles: ["@deepseek-ai/dsh-sdk-minimal"] }
};
String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class DshFileAssociations {
  [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IEnumHandlers {
    [PreserveSig] int Next(uint count, out IHandler handler, out uint fetched);
  }
  [ComImport, Guid("f04061ac-1659-4a3f-a954-775aa57fc083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IHandler {
    void GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string path, out int index);
    [PreserveSig] int IsRecommended();
    void MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string description);
    void Invoke(IDataObject data);
    void CreateInvoker(IDataObject data, [MarshalAs(UnmanagedType.Interface)] out object invoker);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IDataObject data);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHAssocEnumHandlers(string extension, uint filter, out IEnumHandlers handlers);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int AssocQueryString(uint flags, uint kind, string association, string extra, StringBuilder output, ref uint size);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHDefExtractIcon(string path, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
  [DllImport("user32.dll")]
  static extern bool DestroyIcon(IntPtr icon);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int SHLoadIndirectString(string source, StringBuilder output, uint size, IntPtr reserved);

  [DllImport("shlwapi.dll", PreserveSig = false)]
  static extern void SHCreateThreadRef(IntPtr count, out IntPtr reference);
  [DllImport("shlwapi.dll", PreserveSig = false)]
  static extern void SHSetThreadRef(IntPtr reference);
  [DllImport("shell32.dll")]
  static extern void SHSetInstanceExplorer(IntPtr reference);
  [StructLayout(LayoutKind.Sequential)]
  struct Message {
    public IntPtr window;
    public uint message;
    public UIntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int x, y;
    public uint reserved;
  }
  [DllImport("user32.dll", SetLastError = true)]
  static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint milliseconds, IntPtr callback);
  [DllImport("user32.dll")]
  static extern bool KillTimer(IntPtr window, UIntPtr id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")]
  static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr DispatchMessage(ref Message message);

  // Shell handlers may return before their asynchronous launch work releases the host.
  // The shared Shell reference, rather than an arbitrary delay, owns that lifetime.
  static void WithShellLifetime(Action action) {
    IntPtr count = Marshal.AllocHGlobal(sizeof(int));
    IntPtr reference = IntPtr.Zero;
    try {
      Marshal.WriteInt32(count, 0);
      SHCreateThreadRef(count, out reference);
      SHSetThreadRef(reference);
      SHSetInstanceExplorer(reference);
      int owned = Marshal.ReadInt32(count);
      try { action(); }
      finally {
        if (Marshal.ReadInt32(count) > owned) {
          // USER_TIMER_MINIMUM wakes the STA to inspect the reference count while dispatching COM work.
          UIntPtr timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 10, IntPtr.Zero);
          if (timer == UIntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
          try {
            while (Marshal.ReadInt32(count) > owned) {
              Message message;
              if (GetMessage(out message, IntPtr.Zero, 0, 0) <= 0) throw new InvalidOperationException("Shell handoff message loop ended");
              TranslateMessage(ref message);
              DispatchMessage(ref message);
            }
          } finally { KillTimer(IntPtr.Zero, timer); }
        }
      }
    } finally {
      SHSetInstanceExplorer(IntPtr.Zero);
      SHSetThreadRef(IntPtr.Zero);
      int remaining = reference == IntPtr.Zero ? 0 : Marshal.Release(reference);
      // An interrupted drain leaves its counter owned by the terminating helper process.
      if (remaining == 0) Marshal.FreeHGlobal(count);
    }
  }

  public sealed class Application {
    public string id;
    public string name;
    public string icon;
    public bool @default;
  }
  static string Associated(string extension, uint kind) {
    uint size = 0;
    AssocQueryString(0, kind, extension, null, null, ref size);
    if (size == 0) return null;
    var text = new StringBuilder((int)size);
    return AssocQueryString(0, kind, extension, null, text, ref size) == 0 ? text.ToString() : null;
  }
  // Resolve a packaged application's indirect icon reference, for example
  // @{Microsoft.WindowsNotepad_...?ms-resource://.../NotepadAppList.png}, to
  // the resource file the Shell would draw; an unresolved reference is null.
  static string ResolveIndirectIcon(string source) {
    var output = new StringBuilder(1024);
    return SHLoadIndirectString(source, output, (uint)output.Capacity, IntPtr.Zero) == 0 ? output.ToString() : null;
  }
  // Read one icon source into a 32px PNG: an image file directly, otherwise the
  // resource the Shell extracts at the given index. A missing resource is null.
  static string PngFromIconSource(string source, int index) {
    IntPtr large = IntPtr.Zero, small = IntPtr.Zero;
    try {
      if (Path.GetExtension(source).Equals(".png", StringComparison.OrdinalIgnoreCase)) {
        using (var original = Image.FromFile(source))
        using (var resized = new Bitmap(original, new Size(32, 32)))
        using (var stream = new MemoryStream()) {
          resized.Save(stream, ImageFormat.Png);
          return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
        }
      }
      if (SHDefExtractIcon(source, index, 0, out large, out small, 32) != 0 || large == IntPtr.Zero) return null;
      using (var image = Icon.FromHandle(large))
      using (var bitmap = image.ToBitmap())
      using (var stream = new MemoryStream()) {
        bitmap.Save(stream, ImageFormat.Png);
        return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
      }
    } catch (Exception) {
      // Missing icon resources do not make the application unusable.
      return null;
    } finally {
      if (large != IntPtr.Zero) DestroyIcon(large);
      if (small != IntPtr.Zero) DestroyIcon(small);
    }
  }
  // Best-effort fallback: some handlers return their executable path from GetName, but a
  // packaged handler's name may be an AUMID or family name, which extracts no icon.
  static string IconData(IHandler handler, string id) {
    string source = null; int index = 0;
    try { handler.GetIconLocation(out source, out index); } catch (Exception) {
      // A handler without a drawable icon location falls back to its name.
    }
    if (!String.IsNullOrEmpty(source)) {
      source = Environment.ExpandEnvironmentVariables(source);
      if (source.StartsWith("@{", StringComparison.Ordinal) && source.EndsWith("}", StringComparison.Ordinal)) {
        var resolved = ResolveIndirectIcon(source);
        if (!String.IsNullOrEmpty(resolved)) source = resolved;
      }
      var icon = PngFromIconSource(source, index);
      if (icon != null) return icon;
    }
    return String.IsNullOrEmpty(id) || String.Equals(id, source, StringComparison.OrdinalIgnoreCase)
      ? null
      : PngFromIconSource(id, 0);
  }
  static void Visit(string path, Action<IHandler> visit) {
    var extension = Path.GetExtension(path);
    if (extension.Length == 0) return;
    IEnumHandlers handlers;
    SHAssocEnumHandlers(extension, 0, out handlers);
    try {
      while (true) {
        IHandler handler; uint fetched;
        int result = handlers.Next(1, out handler, out fetched);
        Marshal.ThrowExceptionForHR(result);
        if (result != 0 || fetched == 0) break;
        try { visit(handler); } finally { Marshal.FinalReleaseComObject(handler); }
      }
    } finally { Marshal.FinalReleaseComObject(handlers); }
  }
  public static Application[] List(string path) {
    var extension = Path.GetExtension(path);
    var executable = extension.Length == 0 ? null : Associated(extension, 2);
    var appId = extension.Length == 0 ? null : Associated(extension, 21);
    var apps = new List<Application>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    Visit(path, delegate(IHandler handler) {
      string id, name;
      handler.GetName(out id); handler.GetUIName(out name);
      if (!seen.Add(id)) return;
      apps.Add(new Application { id = id, name = name, icon = IconData(handler, id),
        @default = String.Equals(id, executable, StringComparison.OrdinalIgnoreCase) || String.Equals(id, appId, StringComparison.OrdinalIgnoreCase) });
    });
    return apps.ToArray();
  }
  public static void Open(string path, string application) {
    WithShellLifetime(delegate { OpenRegistered(path, application); });
  }
  static void OpenRegistered(string path, string application) {
    bool opened = false;
    Visit(path, delegate(IHandler handler) {
      string id; handler.GetName(out id);
      if (opened || !String.Equals(id, application, StringComparison.OrdinalIgnoreCase)) return;
      var iid = typeof(IShellItem).GUID;
      IShellItem item;
      SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
      IDataObject data = null;
      try {
        var bhid = new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4");
        var dataIid = typeof(IDataObject).GUID;
        item.BindToHandler(IntPtr.Zero, ref bhid, ref dataIid, out data);
        handler.Invoke(data);
        opened = true;
      } finally {
        if (data != null) Marshal.FinalReleaseComObject(data);
        Marshal.FinalReleaseComObject(item);
      }
    });
    if (!opened) throw new InvalidOperationException("Application is not registered for this file");
  }
}`;
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
let Binary;
(function(_Binary) {
	_Binary.is = isArrayBufferLike;
	_Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	_Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	_Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	_Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	_Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	_Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
let Time;
(function(_Time) {
	_Time.millisecond = 1;
	const second = _Time.second = 1e3;
	const minute = _Time.minute = second * 60;
	const hour = _Time.hour = minute * 60;
	const day = _Time.day = hour * 24;
	const week = _Time.week = day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	_Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	_Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / minute - offset) / 1440);
	}
	_Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * minute);
	}
	_Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * week || 0) + (parseFloat(capture[2]) * day || 0) + (parseFloat(capture[3]) * hour || 0) + (parseFloat(capture[4]) * minute || 0) + (parseFloat(capture[5]) * second || 0);
	}
	_Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	_Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= day - hour / 2) return Math.round(ms / day) + "d";
		else if (abs >= hour - minute / 2) return Math.round(ms / hour) + "h";
		else if (abs >= minute - second / 2) return Math.round(ms / minute) + "m";
		else if (abs >= second) return Math.round(ms / second) + "s";
		return ms + "ms";
	}
	_Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	_Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	_Time.template = template;
})(Time || (Time = {}));
/** Index every entry (including nested group members) by id. */
function flatten(data, parent = null, result = /* @__PURE__ */ new Map()) {
	data.forEach((options, position) => {
		if (options.id) result.set(options.id, {
			parent,
			position,
			options,
			list: data
		});
		if (options.group && Array.isArray(options.config)) flatten(options.config, options.id ?? null, result);
	});
	return result;
}
function randomId(used) {
	let id;
	do
		id = Math.random().toString(16).slice(2, 10);
	while (used(id));
	return id;
}
/** Give every entry (nested groups included) an id, in place. */
function ensureIds(entries, used) {
	for (const entry of entries) {
		if (!entry.id) entry.id = randomId(used);
		if (entry.group && Array.isArray(entry.config)) ensureIds(entry.config, used);
	}
}
const JsExpr = new Type("tag:yaml.org,2002:js", {
	kind: "scalar",
	resolve: (data) => typeof data === "string",
	construct: (data) => ({ __jsExpr: data }),
	predicate: isJsExpr,
	represent: (data) => data["__jsExpr"]
});
JSON_SCHEMA.extend(JsExpr);
EntryGroup.key, Service.init;
Object.freeze([
	"aix",
	"android",
	"darwin",
	"freebsd",
	"haiku",
	"linux",
	"openbsd",
	"sunos",
	"win32",
	"cygwin",
	"netbsd"
]);
/** The user patch layer inside a profile directory (hot-reloaded on long-lived surfaces). */
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;
/**
* Initialize a profile directory: manifest, empty user patch layer, and the
* pnpm settings out-of-tree plugins need. Existing files are never touched,
* so re-running is a no-op on an initialized profile.
* @param dir - the profile directory from {@link resolveProfileDir}.
* @param bundles - the initial `dsh.profile.bundles` layer list.
*/
function initProfile(dir, bundles) {
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, "package.json");
	if (!existsSync(manifestPath)) {
		const manifest = {
			name: `dsh-profile-${basename(dir)}`,
			private: true,
			dependencies: {},
			dsh: { profile: { bundles: [...bundles] } }
		};
		writeFileSync(manifestPath, JSON.stringify(manifest, void 0, 2) + "\n");
	}
	const patchPath = join(dir, PROFILE_PATCH_FILENAME);
	if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE);
	const workspacePath = join(dir, "pnpm-workspace.yaml");
	if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE);
}
/** Directory where the link backend of the dsh 0.1.5 releases projected bundle-carried packages into a profile. */
const LINK_PROJECTION_DIR = ".dsh-module-fallback";
/**
* Remove the package projections a link-backend launch left in a profile.
* Only symlinks under the profile's `node_modules` whose target lies inside
* `<profile>/.dsh-module-fallback/node_modules` are unlinked, then that directory is removed;
* pnpm-installed packages and every other symlink stay. A profile without the directory is untouched.
* @param dir - the profile directory.
*/
function removeLinkProjections(dir) {
	const owned = join(dir, LINK_PROJECTION_DIR);
	if (!existsSync(owned)) return;
	const ownedModules = join(owned, "node_modules");
	for (const link of symlinksUnder(join(dir, "node_modules"))) if (pointsInto(link, ownedModules)) unlinkSync(link);
	rmSync(owned, {
		recursive: true,
		force: true
	});
}
/** Top-level and scoped entries under a node_modules directory that are symlinks or junctions. */
function symlinksUnder(modules) {
	const links = [];
	if (!existsSync(modules)) return links;
	for (const entry of readdirSync(modules, { withFileTypes: true })) {
		const path = join(modules, entry.name);
		if (entry.isSymbolicLink()) links.push(path);
		else if (entry.name.startsWith("@") && entry.isDirectory()) {
			for (const child of readdirSync(path, { withFileTypes: true })) if (child.isSymbolicLink()) links.push(join(path, child.name));
		}
	}
	return links;
}
/** Whether a symlink's target directory is `root` or lies below it. */
function pointsInto(link, root) {
	try {
		const target = resolve(dirname(link), readlinkSync(link));
		const parent = realpathSync.native(dirname(target));
		const rootPath = realpathSync.native(root);
		return parent === rootPath || parent.startsWith(rootPath + sep);
	} catch (error) {
		/* v8 ignore next 2 -- a non-ENOENT realpath failure requires a host filesystem fault */
		if (error.code === "ENOENT") return false;
		/* v8 ignore next -- see the host-filesystem exception above */
		throw error;
	}
}
/**
* Read a profile's manifest.
* @param binName - the diagnostic prefix on the thrown error.
* @param dir - the profile directory.
* @returns the parsed manifest.
*/
function readProfileManifest(binName, dir) {
	const path = join(dir, "package.json");
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`${binName}: failed to read profile manifest ${path}: ${String(error)}`);
	}
	const parsed = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${binName}: profile manifest ${path} must hold a JSON object`);
	return parsed;
}
/**
* Write a profile's manifest back (2-space JSON, trailing newline).
* @param dir - the profile directory.
* @param manifest - the manifest value to persist.
*/
function writeProfileManifest(dir, manifest) {
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, void 0, 2) + "\n");
}
/**
* Write a bundle list while preserving the supplied profile's other metadata.
* @param profileDir - directory whose package.json is updated.
* @param manifest - current profile manifest, read after the package operation when applicable.
* @param bundles - ordered active bundle names, including any template entries.
* @returns the written manifest.
*/
function writeProfileBundles(profileDir, manifest, bundles) {
	const updated = {
		...manifest,
		dsh: {
			...manifest.dsh,
			profile: {
				...manifest.dsh?.profile,
				bundles: [...bundles]
			}
		}
	};
	writeProfileManifest(profileDir, updated);
	return updated;
}
/** Filesystem recovery for callers that own profile shutdown and write exclusion. */
/**
* Back up the profile patch and retain only the caller's recovery bundles.
* The caller must stop the profile and exclude concurrent profile writes.
* Installed packages and other manifest fields are preserved; patches are never parsed.
* Failures propagate and may leave completed changes in place for a retry.
* @param binName - Diagnostic prefix for invalid profile manifests.
* @param profileDir - Profile directory to recover without loading its plugins.
* @param bundles - Ordered bundles to enable after recovery.
* @returns Backup path with a Unix millisecond timestamp and optional collision ordinal, or undefined if absent.
*/
function sanitizeProfile(binName, profileDir, bundles) {
	const manifest = existsSync(join(profileDir, "package.json")) ? readProfileManifest(binName, profileDir) : void 0;
	const patchPath = join(profileDir, PROFILE_PATCH_FILENAME);
	const backupBase = `${patchPath}.bak-${Date.now()}`;
	let backupPath = backupBase;
	let ordinal = 0;
	while (existsSync(backupPath)) backupPath = `${backupBase}-${++ordinal}`;
	try {
		renameSync(patchPath, backupPath);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		backupPath = void 0;
	}
	if (manifest !== void 0) writeProfileBundles(profileDir, manifest, bundles);
	return backupPath;
}
Object.freeze({});
//#endregion
//#region lib/types/project-manager.js
/** Desktop profile initialization and native recovery. */
const CORE_BUILD_PACKAGE = "@deepseek-ai/dsh-subprocess-local";
const WEB_PROFILE = PROFILE_TEMPLATES.web;
const WORKSPACE_SETTINGS = "nodeLinker: hoisted\nautoInstallPeers: false\n";
function workspaceFile(overrides = {}) {
	const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right));
	const overrideSection = entries.length === 0 ? "" : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join("\n")}\n`;
	if (entries.length === 0) return `packages:\n  - .\n\n${WORKSPACE_SETTINGS}`;
	const coreBuildSpec = overrides[CORE_BUILD_PACKAGE];
	const coreBuildKey = coreBuildSpec === void 0 ? CORE_BUILD_PACKAGE : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace("file:./", "file:")}`;
	return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`;
}
function migrateProfileSettings(projectDir) {
	const path = join(projectDir, "pnpm-workspace.yaml");
	if (!existsSync(path)) return;
	const legacy = `packages:\n  - .\n\n${WORKSPACE_SETTINGS}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "${CORE_BUILD_PACKAGE}": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`;
	if (readFileSync(path, "utf8").replaceAll("\r\n", "\n") === legacy) writeFileSync(path, workspaceFile());
}
/** Initializes the Desktop profile and disables third-party bundles during recovery. */
var DesktopProjectManager = class {
	paths;
	runtime;
	/**
	* @param paths - Electron-owned package state and reserved desktop profile paths.
	* @param runtime - location of the bundled application runtime.
	*/
	constructor(paths, runtime) {
		this.paths = paths;
		this.runtime = runtime;
	}
	/**
	* Back up the profile patch and disable third-party bundles without loading application resources.
	* The caller must stop the Host first.
	* @returns Backup path after the locked profile write, or undefined if the patch was absent.
	*/
	async disableAllPlugins() {
		return this.withLock(() => sanitizeProfile("dsh", this.paths.profile, WEB_PROFILE.bundles));
	}
	/**
	* Load application metadata and prepare the external plugin profile without installing packages.
	*/
	async applyRelease() {
		await this.withLock(() => {
			readDesktopRuntime(this.runtime.dsh);
			migrateProfileSettings(this.paths.profile);
			createPluginProfile(this.paths.profile);
			removeLinkProjections(this.paths.profile);
		});
	}
	async withLock(operation) {
		mkdirSync(this.paths.profile, {
			recursive: true,
			mode: 448
		});
		const lockPath = join(realpathSync(this.paths.profile), "lock");
		let descriptor;
		try {
			descriptor = openSync(lockPath, "wx", 384);
		} catch (error) {
			if (error.code === "EEXIST") {
				const lock = lstatSync(lockPath);
				if (lock.isSymbolicLink() || !lock.isFile()) throw new Error("desktop project: profile lock is not a regular file");
				const owner = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
				let active = !Number.isSafeInteger(owner) || owner <= 0;
				if (!active) try {
					process.kill(owner, 0);
					active = true;
				} catch (signalError) {
					active = signalError.code !== "ESRCH";
				}
				if (active) throw new Error("desktop project: another profile operation is active");
				unlinkSync(lockPath);
				descriptor = openSync(lockPath, "wx", 384);
			} else throw error;
		}
		try {
			writeSync(descriptor, `${String(process.pid)}\n`);
			fsyncSync(descriptor);
			return await operation();
		} finally {
			closeSync(descriptor);
			unlinkSync(lockPath);
		}
	}
};
/** Create the first external plugin profile without running a package manager. */
function createPluginProfile(projectDir) {
	initProfile(projectDir, WEB_PROFILE.bundles);
}
//#endregion
//#region lib/types/node-environment.js
/** Electron Node-mode startup, with private shell launchers scoped to package installation. */
/**
* Select Electron's Node mode and the shell launcher used by package scripts.
* @param executable - Electron executable running the application.
* @param bin - Directory containing the node shell launcher.
* @param environment - Caller environment preserved for plugin execution.
* @returns Environment for a Node-mode child process.
*/
function desktopNodeEnvironment(executable, bin, environment) {
	return {
		...environment,
		ELECTRON_RUN_AS_NODE: "1",
		...bin === void 0 ? {} : {
			DSH_DESKTOP_NODE_EXECUTABLE: executable,
			PATH: `${bin}${delimiter}${environment.PATH ?? ""}`
		}
	};
}
//#endregion
//#region ../../packages/boot/plugin-manager/lib/types/diagnostic.js
/** Whitelisted operation records shared by diagnostic transport and durable readers. */
const fields = {
	id: uuid().transform((value) => value),
	time: datetime(),
	reason: _enum({
		"plugin": "plugin",
		"bundle": "bundle",
		"install": "install",
		"remove": "remove"
	}),
	target: string().max(256).nullable(),
	stage: _enum({
		"install": "install",
		"enable": "enable",
		"remove": "remove"
	}),
	enabled: boolean().optional(),
	version: string().max(128).optional()
};
const operation = discriminatedUnion("phase", [
	object$1({
		...fields,
		phase: literal("started")
	}),
	object$1({
		...fields,
		phase: literal("unknown")
	}),
	object$1({
		...fields,
		phase: literal("settled"),
		application: _enum({
			"applied": "applied",
			"restart-required": "restart-required",
			"overridden": "overridden",
			"failed": "failed",
			"cancelled": "cancelled"
		}),
		changed: boolean(),
		errorCode: _enum({
			"management-required": "management-required",
			"unaddressable": "unaddressable",
			"unknown-plugin": "unknown-plugin",
			"invalid-spec": "invalid-spec",
			"already-installed": "already-installed",
			"ambiguous-install": "ambiguous-install",
			"not-bundle": "not-bundle",
			"not-removable": "not-removable",
			"stop-profile": "stop-profile",
			"bundle-in-use": "bundle-in-use",
			"stale-approval": "stale-approval",
			"incompatible-version": "incompatible-version",
			"unsupported-platform": "unsupported-platform",
			"unexpected-package": "unexpected-package",
			"operation-error": "operation-error"
		}).optional(),
		restartReason: _enum({
			"no-hmr": "no-hmr",
			"package-moved": "package-moved",
			"host-module": "host-module",
			"unmanaged-plugin": "unmanaged-plugin",
			"module-comparison": "module-comparison"
		}).optional()
	})
]);
const record$3 = object$1({
	runId: uuid().transform((value) => value),
	operation,
	transportDropped: number().int().min(0).max(Number.MAX_SAFE_INTEGER)
});
/**
* Validate transport/file data and discard fields outside the diagnostic whitelist.
* @param value - Untrusted decoded JSON.
* @returns A bounded record, or undefined for malformed, oversized or unsupported records.
*/
function parsePluginOperationRecord(value) {
	const parsed = record$3.safeParse(value);
	return parsed.success ? parsed.data : void 0;
}
//#endregion
//#region lib/types/host-process.js
/** Electron Node-mode child lifecycle for the shared Web application. */
/** Quit inspection deadline; a slower Host counts as unknown work and the shell asks before quitting. */
const QUIT_INSPECTION_DEADLINE_MS = 2e3;
const runIdSchema = uuid();
function isDesktopHostEvent(message) {
	if (typeof message !== "object" || message === null || !("type" in message)) return false;
	const candidate = message;
	switch (candidate.type) {
		case "starting": return runIdSchema.safeParse(candidate.runId).success;
		case "shutdown-complete": return true;
		case "ready": return typeof candidate.url === "string";
		case "platform-session": {
			const session = candidate.session;
			if (session === null) return true;
			if (typeof session !== "object" || !("origin" in session) || !("token" in session) || typeof session.origin !== "string" || typeof session.token !== "string" || session.token.length === 0) return false;
			if (!("userId" in session) || session.userId !== null && (typeof session.userId !== "string" || session.userId.length === 0)) return false;
			if ("embeddedPageDist" in session && typeof session.embeddedPageDist !== "string") return false;
			if ("requestHeaders" in session && (typeof session.requestHeaders !== "object" || session.requestHeaders === null || Array.isArray(session.requestHeaders) || Object.entries(session.requestHeaders).some(([name, value]) => typeof value !== "string" || name !== name.toLowerCase() || /[\r\n]/.test(value) || [
				"authorization",
				"x-dsh-auth-token",
				"host",
				"content-length",
				"transfer-encoding",
				"connection",
				"content-type"
			].includes(name)))) return false;
			try {
				const url = new URL(session.origin);
				return url.origin === session.origin && !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && [
					"localhost",
					"127.0.0.1",
					"[::1]"
				].includes(url.hostname));
			} catch {
				return false;
			}
		}
		case "fatal": return typeof candidate.message === "string" && (candidate.diagnostic === void 0 || typeof candidate.diagnostic === "string");
		case "update-tasks": return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === "boolean" && (candidate.error === void 0 || typeof candidate.error === "string");
		case "file-drag-resource": {
			const resource = candidate.resource;
			return Number.isSafeInteger(candidate.requestId) && (candidate.error === void 0 || typeof candidate.error === "string") && (resource === null || typeof resource === "object" && "path" in resource && typeof resource.path === "string" && "sha256" in resource && typeof resource.sha256 === "string" && /^[a-f0-9]{64}$/u.test(resource.sha256) && "size" in resource && typeof resource.size === "number" && Number.isSafeInteger(resource.size) && resource.size >= 0);
		}
		case "quit-inspection": return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === "boolean" && typeof candidate.scheduledTasks === "boolean" && (candidate.error === void 0 || typeof candidate.error === "string");
		default: return false;
	}
}
async function exitsWithin(exit, milliseconds) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => {
			resolve(false);
		}, milliseconds);
		timer.unref();
	});
	try {
		return await Promise.race([exit.then(() => true), timeout]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
/** The child has exited, but task teardown did not finish successfully. */
var DesktopHostUncleanExitError = class extends Error {};
/**
* A Host failure reported over IPC before the process exited. `message` is what
* the Host chose to show; `diagnostic` is its complete inspected error, kept
* separately so a crash report can print it verbatim instead of a string escaped
* inside another error's properties.
*/
var DesktopHostFatalError = class extends Error {
	#diagnostic;
	/**
	* @param message - The Host's failure message.
	* @param diagnostic - The Host's inspected error, when the Host supplied one.
	*/
	constructor(message, diagnostic) {
		super(message);
		this.#diagnostic = diagnostic;
	}
	/** The Host's inspected error; a getter so `util.inspect` of this error does not repeat it as an escaped property. */
	get diagnostic() {
		return this.#diagnostic;
	}
};
/** One Web backend running under the Electron executable in Node mode. */
var DesktopHostProcess = class {
	node;
	runtimeDir;
	projectDir;
	inspectPort;
	environment;
	onFailure;
	primaryRuntime;
	packageManager;
	onPlatformSession;
	onPluginOperation;
	runId;
	child;
	readyResolve;
	readyReject;
	readyPromise = new Promise((resolve, reject) => {
		this.readyResolve = resolve;
		this.readyReject = reject;
	});
	exitPromise;
	stderr = "";
	failureReported = false;
	stopping = false;
	shutdownCompleted = false;
	nextControlId = 1;
	controlRequests = /* @__PURE__ */ new Map();
	/**
	* @param node - Absolute Electron executable in Node mode.
	* @param runtimeDir - Immutable packages carried by the current application.
	* @param projectDir - Desktop plugin profile and child working directory.
	* @param inspectPort - Optional loopback inspector port for workspace development.
	* @param environment - Environment inherited by the Host and its plugin subprocesses.
	* @param onFailure - Receives the first unexpected child failure, including after readiness.
	* @param primaryRuntime - Optional bundled dependency payload; the Host exposes it to its profile as `DSH_PRIMARY_RUNTIME`.
	* @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
	* @param onPlatformSession - Private credential updates for embedded Platform views.
	* @param onPluginOperation - Optional diagnostic sink; malformed records are ignored without failing the Host.
	*/
	constructor(node, runtimeDir, projectDir, inspectPort, environment = process.env, onFailure, primaryRuntime, packageManager, onPlatformSession, onPluginOperation) {
		this.node = node;
		this.runtimeDir = runtimeDir;
		this.projectDir = projectDir;
		this.inspectPort = inspectPort;
		this.environment = environment;
		this.onFailure = onFailure;
		this.primaryRuntime = primaryRuntime;
		this.packageManager = packageManager;
		this.onPlatformSession = onPlatformSession;
		this.onPluginOperation = onPluginOperation;
	}
	/**
	* Start this child once and await its Web application URL.
	* @returns Ready facts supplied by the child after application startup.
	*/
	async start() {
		if (this.child !== void 0) return this.readyPromise;
		const entry = join(this.runtimeDir, "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "index.js");
		const child = spawn(this.node, [
			"--expose-internals",
			...this.inspectPort === void 0 ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`],
			entry,
			this.runtimeDir,
			this.projectDir,
			this.primaryRuntime ?? "",
			...this.packageManager === void 0 ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin]
		], {
			cwd: this.projectDir,
			env: desktopNodeEnvironment(this.node, void 0, this.environment),
			stdio: [
				"ignore",
				"pipe",
				"pipe",
				"ipc"
			]
		});
		this.child = child;
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-65536);
		});
		child.stdout?.pipe(process.stdout);
		child.on("message", (message) => {
			if (typeof message === "object" && message !== null && "type" in message && message.type === "plugin-operation") {
				const record = "record" in message ? parsePluginOperationRecord(message.record) : void 0;
				if (record !== void 0 && record.runId === this.runId) try {
					this.onPluginOperation?.(record);
				} catch (_error) {
					console.error("desktop plugin operation diagnostic sink failed");
				}
				return;
			}
			if (!isDesktopHostEvent(message)) {
				this.fail(/* @__PURE__ */ new Error("dsh desktop host sent an invalid IPC event"));
				child.kill("SIGTERM");
				return;
			}
			if (message.type === "starting") this.runId = message.runId;
			else if (message.type === "ready") this.readyResolve({
				url: message.url,
				injections: message.injections
			});
			else if (message.type === "platform-session") this.onPlatformSession?.(message.session);
			else if (message.type === "shutdown-complete") if (this.stopping) this.shutdownCompleted = true;
			else this.fail(/* @__PURE__ */ new Error("dsh desktop host acknowledged an unrequested shutdown"));
			else if (message.type === "fatal") this.fail(new DesktopHostFatalError(message.message, message.diagnostic));
			else {
				const request = this.controlRequests.get(message.requestId);
				if (message.error === void 0) request?.resolve(message);
				else request?.reject(new Error(message.error));
			}
		});
		child.once("error", (error) => {
			this.fail(error);
		});
		this.exitPromise = new Promise((resolve) => {
			child.once("close", (code) => {
				const suffix = this.stderr.trim() === "" ? "" : `: ${this.stderr.trim()}`;
				if (code !== 0 && code !== null) this.fail(/* @__PURE__ */ new Error(`dsh desktop host exited with ${String(code)}${suffix}`));
				else this.fail(/* @__PURE__ */ new Error(`dsh desktop host stopped${suffix}`));
				resolve();
			});
		});
		return this.readyPromise;
	}
	/**
	* Inspect active work or lock request admission for update handoff.
	* @param action - Read-only inspection, admission lock, or recovery unlock.
	* @returns Whether live tasks would be affected. Locking drains admitted API requests before inspecting tasks;
	* an unanswered drain fails at the control-request deadline without authorizing installation.
	*/
	async updateTasks(action) {
		const response = await this.control({
			type: "update-tasks",
			action
		}, 1e4, "desktop update: task inspection timed out", "desktop update");
		if (response.type !== "update-tasks") throw new Error("desktop update: Host answered with a different control response");
		return response.active;
	}
	/**
	* Ask the Host what quitting now would interrupt.
	* @returns Active tasks and armed scheduled reminders; rejects when the Host is unavailable or misses
	* {@link QUIT_INSPECTION_DEADLINE_MS}, and the shell then asks before quitting.
	*/
	async inspectQuit() {
		const response = await this.control({ type: "quit-inspection" }, QUIT_INSPECTION_DEADLINE_MS, "desktop quit: inspection timed out", "desktop quit");
		if (response.type !== "quit-inspection") throw new Error("desktop quit: Host answered with a different control response");
		return {
			activeTasks: response.activeTasks,
			scheduledTasks: response.scheduledTasks
		};
	}
	/**
	* @param address - Session-scoped file reference.
	* @param signal - preparation cancellation.
	* @returns privately authorized local resource, or null when nonlocal.
	*/
	async resolveDragResource(address, signal) {
		const response = await this.control({
			type: "file-drag-resource",
			address
		}, 12e3, "File drag authorization timed out", "file drag", signal);
		if (response.type !== "file-drag-resource") throw new Error("Host returned a different control response");
		return response.resource;
	}
	async control(request, deadlineMs, deadlineMessage, operation, signal) {
		const child = this.child;
		if (child === void 0 || !child.connected || this.failureReported || this.stopping) throw new Error(`${operation}: Host is unavailable`);
		signal?.throwIfAborted();
		const requestId = this.nextControlId++;
		let timer;
		const abort = () => {
			if (request.type === "file-drag-resource" && child.connected) child.send({
				type: "file-drag-cancel",
				requestId
			}, (_error) => {});
			const reason = signal?.reason;
			this.controlRequests.get(requestId)?.reject(reason instanceof Error ? reason : new Error(deadlineMessage));
		};
		try {
			return await new Promise((resolve, reject) => {
				this.controlRequests.set(requestId, {
					resolve,
					reject
				});
				timer = setTimeout(abort, deadlineMs);
				signal?.addEventListener("abort", abort, { once: true });
				child.send({
					...request,
					requestId
				}, (error) => {
					if (error !== null) reject(error);
				});
			});
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			this.controlRequests.delete(requestId);
		}
	}
	/**
	* Request teardown and await child exit, escalating termination when needed.
	* @param requireGraceful - Reject update handoff after forced termination or unsuccessful child exit.
	* @returns Completion of owned process teardown. DesktopHostUncleanExitError confirms exit but refuses installation;
	* other failures do not confirm exit.
	*/
	async stop(requireGraceful = false) {
		const child = this.child;
		if (child === void 0) return;
		this.stopping = true;
		this.onPlatformSession?.(null);
		if (child.connected) child.send({ type: "shutdown" }, (error) => {
			if (error !== null) this.fail(error);
		});
		const exited = this.exitPromise ?? Promise.resolve();
		const graceful = await exitsWithin(exited, 1e4);
		if (!graceful) child.kill("SIGTERM");
		if (!await exitsWithin(exited, 5e3)) {
			child.kill("SIGKILL");
			if (!await exitsWithin(exited, 5e3)) throw new Error("dsh desktop host did not exit after SIGKILL");
		}
		this.child = void 0;
		if (requireGraceful && (!graceful || child.exitCode !== 0 || !this.shutdownCompleted)) throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(this.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`);
	}
	fail(error) {
		if (this.runId !== void 0) Object.assign(error, { hostRunId: this.runId });
		this.onPlatformSession?.(null);
		this.readyReject(error);
		for (const request of this.controlRequests.values()) request.reject(error);
		this.controlRequests.clear();
		if (!this.failureReported && !this.stopping) {
			this.failureReported = true;
			try {
				this.onFailure?.(error);
			} catch (listenerError) {
				console.error("desktop host failure listener failed", listenerError);
			}
		}
	}
};
//#endregion
//#region ../../packages/credentials/deepseek-account/lib/types/client-metadata.js
/** Merge Cookie header pairs by case-sensitive name, retaining unrelated cookies.
* @param base - existing request cookies.
* @param override - deployment cookies whose values take precedence.
* @returns one Cookie header with at most one pair per name.
*/
function mergePlatformCookies(base, override) {
	const cookies = /* @__PURE__ */ new Map();
	for (const header of [base, override]) for (const pair of header.split(";")) {
		const separator = pair.indexOf("=");
		if (separator < 1) continue;
		cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
	}
	return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
/**
* Identify native desktop API requests; null leaves non-desktop requests unchanged.
* @param platform - Operating system supplied by the desktop composition.
* @returns Platform request headers shared by account and update-policy clients.
*/
function desktopClientHeaders(platform) {
	if (platform === null) return {};
	return { "x-client-platform": platform === "win32" ? "desktop-win" : "desktop-mac" };
}
/**
* Build the Platform client identity headers for one call.
* @param platform - Operating system supplied by the desktop composition; null identifies the client as web.
* @param client - identity of the requesting UI for this call.
* @returns the five client headers; the bundle ID is intentionally empty.
*/
function platformClientHeaders(platform, client) {
	return {
		"x-client-bundle-id": "",
		"x-client-platform": "web",
		...desktopClientHeaders(platform),
		"x-client-version": client.version,
		"x-client-locale": platformWireLocale(client.locale),
		"x-client-timezone-offset": String(client.timezoneOffsetSeconds)
	};
}
/**
* Reduce a caller's UI language to the region-tagged Platform locale.
* Shares one normalization with the header and with request body locale fields.
* @param locale - active UI language such as `zh-CN`, `zh_TW`, or `en-US`.
* @returns the region-tagged Platform locale for that language, `zh_CN` or `en_US`.
*/
function platformWireLocale(locale) {
	return locale.toLowerCase().split(/[-_]/)[0] === "zh" ? "zh_CN" : "en_US";
}
//#endregion
//#region lib/types/client-metadata.js
/**
* Read the client build version inlined by the Desktop build.
* @returns the version embedded in this application build.
* @throws Error when the build carries no client version, instead of reporting a guessed one.
*/
function desktopClientVersion() {
	return "0.2.2-rc.3";
}
/**
* Sample the Desktop client identity for one Platform request.
* @param locale - current resolved Desktop language.
* @returns this call's build version, the raw active language, and the UTC offset in whole seconds east.
*/
function desktopClientMetadata(locale) {
	return {
		version: desktopClientVersion(),
		locale,
		timezoneOffsetSeconds: -(/* @__PURE__ */ new Date()).getTimezoneOffset() * 60
	};
}
//#endregion
//#region lib/types/platform-ipc.js
/** Shared names for the desktop Platform bridge. */
/** Private desktop channels; the Platform renderer receives bootstrap and locale updates. */
const PLATFORM_IPC = {
	bootstrap: "dsh-platform:bootstrap",
	localeChanged: "dsh-platform:locale-changed",
	open: "dsh-platform:open",
	bounds: "dsh-platform:bounds",
	close: "dsh-platform:close"
};
//#endregion
//#region lib/types/platform-view.js
/**
* Decode the renderer rectangle before allocating a native view.
* @param value - IPC payload.
* @returns finite, nonnegative integer coordinates.
*/
function platformBounds(value) {
	if (typeof value !== "object" || value === null) throw new Error("Invalid Platform bounds");
	const row = value;
	const result = {
		x: 0,
		y: 0,
		width: 0,
		height: 0
	};
	for (const key of [
		"x",
		"y",
		"width",
		"height"
	]) {
		const n = row[key];
		if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e5) throw new Error("Invalid Platform bounds");
		result[key] = Math.round(n);
	}
	return result;
}
/** Native view and its credential snapshot are discarded together. */
var DesktopPlatformView = class {
	preload;
	getLocale;
	platform;
	blocked;
	account = null;
	view;
	owner;
	releaseOwner;
	generation = 0;
	storageCleanup = /* @__PURE__ */ new Map();
	disposed = false;
	/**
	* @param preload - bundled sandboxed Platform preload path.
	* @param getLocale - current resolved Desktop language.
	* @param platform - operating system this shell runs on, reported to Platform.
	* @param blocked - Whether shell policy or an update prompt prevents opening a product view.
	*/
	constructor(preload, getLocale, platform, blocked) {
		this.preload = preload;
		this.getLocale = getLocale;
		this.platform = platform;
		this.blocked = blocked;
	}
	/** @param next - private Host credentials; identity enrichment preserves an already open temporary document. */
	setSession(next) {
		if (next?.token === this.account?.token && next?.origin === this.account?.origin && next?.embeddedPageDist === this.account?.embeddedPageDist && JSON.stringify(next?.requestHeaders) === JSON.stringify(this.account?.requestHeaders)) {
			if (next?.userId === this.account?.userId || this.account?.userId === null) {
				this.account = next;
				return;
			}
		}
		this.close();
		this.account = next;
	}
	/**
	* Open account-scoped persistent storage, or temporary storage when the account ID is unavailable.
	* @param owner - application window containing the view.
	* @param page - explicit supported Platform page.
	* @param bounds - owned renderer rectangle.
	* @returns when loading finishes, or without a document when superseded or the owner closes or navigates.
	* @throws When a shell update prompt blocks admission, including after storage cleanup.
	*/
	async open(owner, page, bounds) {
		if (this.disposed) throw new Error("Platform view disposed");
		if (this.blocked(owner)) throw new Error("Platform view blocked by update prompt");
		this.close();
		const account = this.account;
		if (account === null) throw new Error("Platform account unavailable");
		if (owner.isDestroyed()) return;
		const generation = this.generation;
		this.owner = owner;
		const closeOwnedView = () => {
			if (generation === this.generation) this.close();
		};
		const navigateOwner = (_event, _url, isInPlace, isMainFrame) => {
			if (isMainFrame && !isInPlace) closeOwnedView();
		};
		owner.webContents.on("did-start-navigation", navigateOwner);
		owner.webContents.on("render-process-gone", closeOwnedView);
		owner.webContents.on("destroyed", closeOwnedView);
		owner.on("closed", closeOwnedView);
		this.releaseOwner = () => {
			owner.webContents.removeListener("did-start-navigation", navigateOwner);
			owner.webContents.removeListener("render-process-gone", closeOwnedView);
			owner.webContents.removeListener("destroyed", closeOwnedView);
			owner.removeListener("closed", closeOwnedView);
		};
		const partition = account.userId === null ? `dsh-platform-${randomUUID()}` : `persist:dsh-platform-${createHash("sha256").update(JSON.stringify([account.origin, account.userId])).digest("hex")}`;
		const browserSession = session.fromPartition(partition);
		const failure = await this.cleanStorage(browserSession);
		if (generation !== this.generation) return;
		if (this.blocked(owner)) {
			this.close();
			throw new Error("Platform view blocked by update prompt");
		}
		if (failure !== null) {
			this.close();
			throw failure.error;
		}
		browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
			callback(false);
		});
		browserSession.setPermissionCheckHandler(() => false);
		const deploymentHeaders = account.requestHeaders ?? {};
		const injectedNames = new Set([...Object.keys(deploymentHeaders), ...Object.keys(platformClientHeaders(this.platform, desktopClientMetadata(this.getLocale())))].map((name) => name.toLowerCase()));
		const injectedRequests = /* @__PURE__ */ new Set();
		browserSession.webRequest.onCompleted((details) => {
			injectedRequests.delete(details.id);
		});
		browserSession.webRequest.onErrorOccurred((details) => {
			injectedRequests.delete(details.id);
		});
		browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
			let headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]));
			if (new URL(details.url).origin === account.origin) {
				injectedRequests.add(details.id);
				const injected = {
					...deploymentHeaders,
					...platformClientHeaders(this.platform, desktopClientMetadata(this.getLocale()))
				};
				const cookie = headers.cookie ?? "";
				Object.assign(headers, injected);
				if (injected.cookie !== void 0) headers.cookie = mergePlatformCookies(cookie, injected.cookie);
			} else if (injectedRequests.has(details.id)) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !injectedNames.has(name.toLowerCase())));
			callback({ requestHeaders: headers });
		});
		const view = new WebContentsView({ webPreferences: {
			session: browserSession,
			preload: this.preload,
			sandbox: true,
			contextIsolation: true,
			additionalArguments: [`--dsh-platform-origin=${account.origin}`],
			nodeIntegration: false,
			webSecurity: true
		} });
		this.view = view;
		view.webContents.setWindowOpenHandler(({ url }) => {
			const destination = new URL(url);
			if (destination.protocol === "https:" && !destination.username && !destination.password) shell.openExternal(url).catch(() => {});
			return { action: "deny" };
		});
		const allowNavigation = (url) => {
			try {
				const parsed = new URL(url);
				return parsed.origin === account.origin && !parsed.username && !parsed.password;
			} catch {
				return false;
			}
		};
		view.webContents.on("will-navigate", (event, url) => {
			if (!allowNavigation(url)) event.preventDefault();
		});
		view.webContents.on("will-redirect", (event, url) => {
			if (!allowNavigation(url)) event.preventDefault();
		});
		view.webContents.on("will-attach-webview", (event) => {
			event.preventDefault();
		});
		view.webContents.on("preload-error", () => {
			if (this.view === view) this.close();
		});
		view.webContents.on("render-process-gone", () => {
			if (this.view === view) this.close();
		});
		view.setVisible(false);
		owner.contentView.addChildView(view);
		view.setBounds(bounds);
		try {
			const url = new URL(page === "usage" ? "/usage" : "/top_up", account.origin);
			if (account.embeddedPageDist) url.searchParams.set("dist", account.embeddedPageDist);
			await view.webContents.loadURL(url.href);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ERR_ABORTED")) {
				if (generation === this.generation) this.close();
				throw error;
			}
		}
		if (generation === this.generation && this.view === view) view.setVisible(true);
	}
	/** @param bounds - current application viewport rectangle. */
	setBounds(bounds) {
		this.view?.setBounds(bounds);
	}
	/**
	* Return prepared credentials and resolved language only to the current Platform main frame.
	* @param event - Electron-provided sender identity.
	* @returns credentials and current language copied into the isolated preload.
	*/
	bootstrap(event) {
		const view = this.view;
		const account = this.account;
		if (view === void 0 || account === null || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame || new URL(event.senderFrame.url).origin !== account.origin) throw new Error("Rejected Platform bootstrap");
		return {
			origin: account.origin,
			token: account.token,
			locale: this.getLocale()
		};
	}
	/** Notify the current document after the Desktop language changes. */
	notifyLocaleChanged() {
		const view = this.view;
		if (view !== void 0 && !view.webContents.isDestroyed()) view.webContents.send(PLATFORM_IPC.localeChanged, this.getLocale());
	}
	/** Destroy the document and clear authentication; account-scoped page preferences survive reopening. */
	close() {
		this.generation++;
		const view = this.view;
		this.view = void 0;
		this.releaseOwner?.();
		this.releaseOwner = void 0;
		const owner = this.owner;
		this.owner = void 0;
		if (view === void 0) return;
		if (owner !== void 0 && !owner.isDestroyed()) owner.contentView.removeChildView(view);
		const browserSession = view.webContents.session;
		const destroyed = new Promise((resolve) => {
			if (view.webContents.isDestroyed()) resolve();
			else {
				view.webContents.once("destroyed", resolve);
				view.webContents.close({ waitForBeforeUnload: false });
			}
		});
		browserSession.webRequest.onBeforeSendHeaders(null);
		browserSession.webRequest.onCompleted(null);
		browserSession.webRequest.onErrorOccurred(null);
		browserSession.flushStorageData();
		this.cleanStorage(browserSession, destroyed);
	}
	/** Stop accepting documents and await all scheduled authentication cleanup. */
	async dispose() {
		this.disposed = true;
		this.account = null;
		await this.closeAndWait();
	}
	/** Destroy the current document and await authentication cleanup before an installer takes over. */
	async closeAndWait() {
		this.close();
		const failures = (await Promise.all(this.storageCleanup.values())).filter((result) => result !== null);
		if (failures.length > 0) throw new AggregateError(failures.map((result) => result.error), "Platform storage cleanup failed");
	}
	cleanStorage(browserSession, destroyed = Promise.resolve()) {
		const previous = this.storageCleanup.get(browserSession);
		const cleanup = Promise.all([previous, destroyed]).then(async () => {
			await browserSession.closeAllConnections();
			const failures = (await Promise.allSettled([
				browserSession.clearStorageData(browserSession.isPersistent() ? { storages: [
					"cookies",
					"filesystem",
					"indexdb",
					"shadercache",
					"serviceworkers",
					"cachestorage"
				] } : void 0),
				browserSession.clearCache(),
				browserSession.clearAuthCache()
			])).filter((result) => result.status === "rejected");
			if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "Platform storage cleanup failed");
		}).then(() => null, (error) => ({ error }));
		this.storageCleanup.set(browserSession, cleanup);
		return cleanup;
	}
};
//#endregion
//#region lib/types/file-drag-files.js
/** Application-owned temporary exports and authorized borrowed files for native dragging. */
const MAX_TOTAL_DRAG_FILE_BYTES = 64 * 1024 * 1024;
const DELIVERED_FILE_RETENTION_MS = 6e4;
/** Borrowed files are never deleted; temporary exports retain cleanup ownership until removal succeeds. */
var DragFiles = class {
	temporaryDirectory;
	files = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Set();
	releasing = /* @__PURE__ */ new Map();
	stagedBytes = 0;
	disposed = false;
	/** @param temporaryDirectory - OS directory for private temporary exports. */
	constructor(temporaryDirectory) {
		this.temporaryDirectory = temporaryDirectory;
	}
	/** @param bytes - complete file bytes. @param naming - desired export name. @returns an opaque preparation handle. */
	prepare(bytes, naming) {
		if (this.disposed || bytes.byteLength > MAX_TOTAL_DRAG_FILE_BYTES - this.stagedBytes) return Promise.reject(/* @__PURE__ */ new Error("File drag temporary storage unavailable"));
		this.stagedBytes += bytes.byteLength;
		const operation = this.write(bytes, resolveDragFileName(naming));
		this.pending.add(operation);
		operation.then(() => {
			this.pending.delete(operation);
		}, () => {
			this.pending.delete(operation);
		});
		return operation;
	}
	async write(bytes, name) {
		let directory;
		try {
			directory = await mkdtemp(join(this.temporaryDirectory, "dsh-file-drag-"));
		} catch (error) {
			this.stagedBytes -= bytes.byteLength;
			throw error;
		}
		const handle = randomUUID();
		const file = {
			directory,
			path: join(directory, name),
			bytes: bytes.byteLength,
			used: false,
			ready: false
		};
		this.files.set(handle, file);
		try {
			await writeFile(file.path, bytes, {
				flag: "wx",
				mode: 384
			});
			if (this.disposed) throw new Error("File transfer closed");
			file.ready = true;
			return handle;
		} catch (error) {
			await this.remove(handle, file);
			throw error;
		}
	}
	/**
	* Register an authorized source without owning its content.
	* @param path - verified local source.
	* @returns borrowed handle.
	*/
	borrow(path) {
		if (this.disposed) throw new Error("File transfer closed");
		const handle = randomUUID();
		this.files.set(handle, {
			path,
			bytes: 0,
			used: false,
			ready: true
		});
		return handle;
	}
	/** @param handle - preparation identity. @param retain - whether the OS accepted this file. @returns path only while ready and owned. */
	take(handle, retain = true) {
		if (typeof handle !== "string") return void 0;
		const key = handle;
		const file = this.files.get(key);
		if (file === void 0 || !file.ready || this.disposed || this.releasing.has(key)) return void 0;
		if (retain && !file.used) {
			file.used = true;
			file.timer = setTimeout(() => {
				this.remove(key, file).catch((error) => {
					console.error(error);
				});
			}, DELIVERED_FILE_RETENTION_MS);
			file.timer.unref();
		}
		return file.path;
	}
	/** Release unused preparations immediately; used exports have a bounded read grace period. @param handle - preparation identity. */
	async release(handle) {
		if (typeof handle !== "string") return;
		const key = handle;
		const file = this.files.get(key);
		if (file === void 0 || file.used) return;
		await this.remove(key, file);
	}
	remove(handle, file) {
		const existing = this.releasing.get(handle);
		if (existing !== void 0) return existing;
		clearTimeout(file.timer);
		file.ready = false;
		const operation = (file.directory === void 0 ? Promise.resolve() : rm(file.directory, {
			recursive: true,
			force: true
		})).then(() => {
			this.files.delete(handle);
			this.stagedBytes -= file.bytes;
		}).finally(() => {
			this.releasing.delete(handle);
		});
		this.releasing.set(handle, operation);
		return operation;
	}
	/** Stop preparation, await every write/release, and retry all tracked removals before reporting failure. */
	async dispose() {
		this.disposed = true;
		await Promise.allSettled(this.pending);
		await Promise.allSettled(this.releasing.values());
		const failure = (await Promise.allSettled([...this.files].map(([handle, file]) => this.remove(handle, file)))).find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}
};
//#endregion
//#region lib/types/file-drag.js
/** Native copy drags authorized only for the product main frame and the active Host. */
function requestOf(value) {
	if (typeof value !== "object" || value === null || !("kind" in value) || !("mediaType" in value) || typeof value.mediaType !== "string" || "name" in value && value.name !== void 0 && typeof value.name !== "string" || "outputExtension" in value && value.outputExtension !== void 0 && typeof value.outputExtension !== "string") throw new Error("Invalid file drag request");
	const naming = {
		mediaType: value.mediaType,
		name: "name" in value ? value.name : void 0,
		outputExtension: "outputExtension" in value ? value.outputExtension : void 0
	};
	if (value.kind === "bytes" && "bytes" in value && value.bytes instanceof Uint8Array) return {
		kind: "bytes",
		bytes: value.bytes,
		...naming
	};
	if (value.kind === "resource" && "address" in value && typeof value.address === "string" && (!("sha256" in value) || typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256)) && (!("size" in value) || typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0)) return {
		kind: "resource",
		address: value.address,
		...naming,
		..."sha256" in value ? { sha256: value.sha256 } : {},
		..."size" in value ? { size: value.size } : {}
	};
	throw new Error("Invalid file drag request");
}
function sameVersion(before, after) {
	return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.size === after.size;
}
async function verifiedVersion(resource, signal) {
	signal.throwIfAborted();
	const info = await stat(resource.path);
	if (!info.isFile() || info.size !== resource.size) return void 0;
	const hash = createHash("sha256");
	const chunks = createReadStream(resource.path, { signal });
	for await (const chunk of chunks) {
		if (!(chunk instanceof Uint8Array)) throw new Error("File stream returned non-binary data");
		hash.update(chunk);
	}
	const after = await stat(resource.path);
	return sameVersion(info, after) && hash.digest("hex") === resource.sha256 ? after : void 0;
}
async function cancellable(operation, signal) {
	signal.throwIfAborted();
	const cancelled = Promise.withResolvers();
	const abort = () => {
		cancelled.reject(signal.reason);
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([operation, cancelled.promise]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
/**
* Register file preparation and native dragging.
* @param owner - shared product sender authorization, returning its window.
* @param resolveResource - cancellable private Host authorization; renderer paths are never used directly.
* @returns cleanup aborting resource reads and awaiting tracked writes/removals without waiting for the system icon service.
*/
function installDesktopFileDrag(owner, resolveResource) {
	let disposed = false;
	const preparations = /* @__PURE__ */ new Map();
	const files = new DragFiles(app.getPath("temp"));
	const pending = /* @__PURE__ */ new Set();
	const icons = /* @__PURE__ */ new Map();
	const borrowed = /* @__PURE__ */ new Map();
	const authorize = (event) => {
		if (disposed) throw new Error("File transfer closed");
		return owner(event);
	};
	const prepare = async (event, value, signal) => {
		authorize(event);
		const source = requestOf(value);
		let handle;
		if (source.kind === "bytes") handle = await files.prepare(source.bytes, source);
		else {
			const resource = await cancellable(resolveResource(source.address, signal), signal);
			authorize(event);
			if (resource === null || basename(resource.path) !== resolveDragFileName(source) || source.sha256 !== void 0 && source.sha256 !== resource.sha256 || source.size !== void 0 && source.size !== resource.size) return void 0;
			const version = await verifiedVersion(resource, signal);
			if (version === void 0) return void 0;
			handle = files.borrow(resource.path);
			borrowed.set(handle, {
				resource,
				version
			});
		}
		try {
			signal.throwIfAborted();
			const file = files.take(handle, false);
			if (file === void 0) throw new Error("File transfer closed");
			const icon = await cancellable(app.getFileIcon(file, { size: "normal" }), signal);
			authorize(event);
			icons.set(handle, icon);
			return handle;
		} catch (error) {
			borrowed.delete(handle);
			await files.release(handle);
			throw error;
		}
	};
	ipcMain.handle(DESKTOP_IPC.fileDragPrepare, (event, source, requestId) => {
		authorize(event);
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128 || preparations.has(requestId)) throw new Error("Invalid file preparation identity");
		const abort = new AbortController();
		preparations.set(requestId, abort);
		const operation = prepare(event, source, abort.signal).finally(() => {
			preparations.delete(requestId);
		});
		pending.add(operation);
		operation.then(() => {
			pending.delete(operation);
		}, () => {
			pending.delete(operation);
		});
		return operation;
	});
	ipcMain.handle(DESKTOP_IPC.fileDragCancel, (event, requestId) => {
		authorize(event);
		if (typeof requestId === "string") preparations.get(requestId)?.abort(/* @__PURE__ */ new Error("File preparation cancelled"));
	});
	ipcMain.handle(DESKTOP_IPC.fileDragStart, (event, handle) => {
		const window = authorize(event);
		const icon = typeof handle === "string" ? icons.get(handle) : void 0;
		if (icon === void 0 || typeof handle !== "string") return false;
		const file = files.take(handle, false);
		if (file === void 0) return false;
		try {
			const original = borrowed.get(handle);
			if (original !== void 0 && !sameVersion(original.version, statSync(original.resource.path))) throw new Error("File changed before dragging");
			authorize(event);
			window.webContents.startDrag({
				file,
				icon
			});
			files.take(handle);
			icons.delete(handle);
			borrowed.delete(handle);
			return true;
		} catch (_error) {
			icons.delete(handle);
			borrowed.delete(handle);
			files.release(handle).catch((error) => {
				console.error(error);
			});
			return false;
		}
	});
	ipcMain.handle(DESKTOP_IPC.fileDragRelease, async (event, handle) => {
		authorize(event);
		if (typeof handle === "string") {
			icons.delete(handle);
			borrowed.delete(handle);
		}
		await files.release(handle);
	});
	return async () => {
		if (!disposed) {
			disposed = true;
			for (const abort of preparations.values()) abort.abort(/* @__PURE__ */ new Error("File transfer closed"));
			ipcMain.removeHandler(DESKTOP_IPC.fileDragPrepare);
			ipcMain.removeHandler(DESKTOP_IPC.fileDragCancel);
			ipcMain.removeHandler(DESKTOP_IPC.fileDragStart);
			ipcMain.removeHandler(DESKTOP_IPC.fileDragRelease);
		}
		await Promise.allSettled(pending);
		icons.clear();
		borrowed.clear();
		await files.dispose();
	};
}
//#endregion
//#region lib/types/directory-picker.js
/** Window-owned workspace directory dialogs for the local Desktop renderer. */
/**
* Install the application-lifetime directory picker IPC handler.
* @param getWindow - Current local application window; shell pages and subframes cannot open dialogs.
*/
function installDesktopDirectoryPicker(getWindow) {
	const pending = /* @__PURE__ */ new WeakMap();
	ipcMain.handle(DESKTOP_IPC.directoryPick, async (event) => {
		const window = getWindow();
		if (window === void 0 || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("dsh desktop: rejected directory picker from an unowned renderer");
		assertDesktopSender(event, ["app"]);
		const existing = pending.get(window);
		if (existing !== void 0) return existing;
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
		const result = dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] }).then(({ canceled, filePaths }) => window.isDestroyed() || canceled ? null : filePaths[0] ?? null).finally(() => {
			pending.delete(window);
		});
		pending.set(window, result);
		return result;
	});
}
//#endregion
//#region lib/types/microphone-permissions.js
/** Microphone access belongs to the primary application frame and the operating system. */
function applicationFrame(url) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "dsh-app:" && parsed.hostname === "app";
	} catch (_error) {
		return false;
	}
}
/**
* Handle microphone requests from the owned application window; other permissions retain Electron's defaults.
* @param session - application's browser session.
* @param primary - current primary window contents, absent while no window is open.
*/
function installMicrophonePermissions(session, primary) {
	session.setPermissionCheckHandler((contents, permission, origin, details) => {
		if (permission !== "media") return true;
		return contents != null && contents === primary() && details.isMainFrame && applicationFrame(origin) && details.mediaType === "audio" && (process.platform !== "darwin" || systemPreferences.getMediaAccessStatus("microphone") === "granted");
	});
	session.setPermissionRequestHandler((contents, permission, callback, details) => {
		if (permission !== "media") {
			callback(true);
			return;
		}
		if (!(contents === primary() && details.isMainFrame && applicationFrame(details.requestingUrl) && "mediaTypes" in details && details.mediaTypes.length === 1 && details.mediaTypes[0] === "audio")) {
			callback(false);
			return;
		}
		if (process.platform !== "darwin") {
			callback(true);
			return;
		}
		systemPreferences.askForMediaAccess("microphone").then(callback, () => {
			callback(false);
		});
	});
}
//#endregion
//#region lib/types/startup-error.js
/** Serializable Desktop failure diagnostics. */
/**
* Preserve nested diagnostics when sending failures to a renderer.
* @param error - Startup or runtime failure.
* @returns Serializable error state.
*/
function desktopErrorState(error) {
	return {
		phase: "error",
		message: error instanceof AggregateError ? [error.message, ...error.errors.map((item) => desktopErrorState(item).message)].join("\n") : error instanceof Error ? error.message : String(error)
	};
}
//#endregion
//#region lib/types/backend-controller.js
/** Owns one backend startup and its quiescent teardown independently of windows. */
/** The error state for one failure: rendered message plus the failure itself. */
function errorState(failure) {
	return {
		...desktopErrorState(failure),
		failure
	};
}
/** Serializes retries and prevents children from outliving a closed window. */
var DesktopBackendController = class {
	createHost;
	publish;
	current = { phase: "starting" };
	attempt;
	pending;
	stopping;
	closed = false;
	/**
	* @param createHost - Allocate a child and route its fatal failures to the supplied callback.
	* @param publish - Receive availability changes until the controller closes.
	*/
	constructor(createHost, publish) {
		this.createHost = createHost;
		this.publish = publish;
	}
	/** Current availability, including the last startup or child failure. */
	get state() {
		return this.current;
	}
	/** Child available to application requests; absent during startup and teardown. */
	get host() {
		return !this.closed && !this.attempt?.cancelled && this.current.phase === "ready" ? this.attempt?.host : void 0;
	}
	/**
	* Prepare the profile and start one child; concurrent callers share the attempt.
	* @param prepare - Profile preparation that must finish before spawning.
	* @returns Completion of startup, rejecting on preparation, startup, or cleanup failure.
	*/
	start(prepare) {
		if (this.closed) return Promise.reject(/* @__PURE__ */ new Error("desktop backend is closed"));
		if (this.stopping !== void 0) return Promise.reject(/* @__PURE__ */ new Error("desktop backend is stopping"));
		if (this.pending !== void 0) return this.pending;
		if (this.current.phase === "ready") return Promise.resolve();
		const previous = this.attempt;
		const attempt = {
			cancelled: false,
			...previous?.cleanup === void 0 ? {} : { cleanup: previous.cleanup }
		};
		this.attempt = attempt;
		this.update({ phase: "starting" });
		const pending = Promise.resolve().then(async () => {
			try {
				await previous?.cleanup;
				delete attempt.cleanup;
				if (attempt.cancelled) return;
				await prepare();
				if (attempt.cancelled) return;
				const host = this.createHost((error) => {
					this.failed(attempt, error);
				});
				attempt.host = host;
				await host.start();
				if (attempt.failure !== void 0) throw attempt.failure;
				if (!attempt.cancelled) this.update({ phase: "ready" });
			} catch (error) {
				const cancelled = attempt.cancelled;
				attempt.cancelled = true;
				let failure = error;
				try {
					await this.cleanup(attempt);
				} catch (cleanupError) {
					if (cleanupError !== error) failure = new AggregateError([error, cleanupError], "desktop backend startup and cleanup failed");
				}
				if (!cancelled) this.update(errorState(failure));
				throw failure;
			}
		}).finally(() => {
			if (this.pending === pending) this.pending = void 0;
		});
		this.pending = pending;
		return pending;
	}
	/**
	* Stop pending preparation and the child before allowing another start.
	* @returns Completion of pending work and child exit; rejects if cleanup fails.
	*/
	stop() {
		if (this.stopping !== void 0) return this.stopping;
		const attempt = this.attempt;
		if (attempt !== void 0) attempt.cancelled = true;
		if (!this.closed) this.update({ phase: "starting" });
		const pending = this.pending;
		const stopping = Promise.allSettled([attempt === void 0 ? Promise.resolve() : this.cleanup(attempt), pending]).then((results) => {
			const cleanup = results[0];
			if (cleanup.status === "rejected") throw cleanup.reason;
			if (this.attempt === attempt) this.attempt = void 0;
		}).finally(() => {
			if (this.stopping === stopping) this.stopping = void 0;
		});
		this.stopping = stopping;
		return stopping;
	}
	/**
	* Permanently prevent startup and suppress further availability notifications.
	* @returns Completion of pending work and child exit; rejects if cleanup fails.
	*/
	close() {
		this.closed = true;
		return this.stop();
	}
	cleanup(attempt) {
		if (attempt.cleanup === void 0) attempt.cleanup = Promise.resolve().then(async () => {
			await attempt.host?.stop();
		});
		return attempt.cleanup;
	}
	failed(attempt, error) {
		if (this.attempt !== attempt || attempt.cancelled) return;
		attempt.failure = error;
		if (this.current.phase !== "ready") return;
		attempt.cancelled = true;
		const cleanup = this.cleanup(attempt);
		this.update(errorState(error));
		cleanup.catch((cleanupError) => {
			if (this.attempt === attempt) this.update(errorState(new AggregateError([error, cleanupError], "Desktop backend failed and could not stop")));
		});
	}
	update(state) {
		if (this.closed) return;
		this.current = state;
		try {
			this.publish(state);
		} catch (error) {
			console.error("desktop backend state listener failed", error);
		}
	}
};
//#endregion
//#region lib/types/device-info.js
/** Local machine description sent with the Desktop feedback questionnaire. */
/**
* Read the local machine description attached to a Desktop feedback submission.
* Fields are `name=value` pairs separated by `; `, in platform, os, app_arch, cpu and
* memory_gib order; memory is total physical memory in GiB with one decimal.
* @returns the machine description, with unavailable fields omitted.
*/
function readDeviceInfo() {
	const fields = [`platform=${process.platform}`];
	collect(fields, "os", () => process.getSystemVersion());
	fields.push(`app_arch=${process.arch}`);
	collect(fields, "cpu", () => cpus()[0]?.model);
	collect(fields, "memory_gib", () => (totalmem() / 1024 ** 3).toFixed(1));
	return fields.join("; ");
}
/**
* Append one optional field, omitting the field when its source is empty or fails.
* @param fields - collected fields, appended in call order.
* @param name - field name written before `=`.
* @param read - source of the field value.
*/
function collect(fields, name, read) {
	let value;
	try {
		value = read();
	} catch (_error) {
		return;
	}
	if (value !== void 0 && value !== "") fields.push(`${name}=${value}`);
}
//#endregion
//#region lib/types/locale.js
/** Typed shell copy for every shipped language owned by the Electron shell. */
const en = {
	cliCommandMenu: "Manage dsh Command…",
	cliCommandTitle: "Manage dsh Command",
	cliCommandLocation: "Desktop command: {path}",
	cliCommandSelected: "Current dsh command: {path}",
	cliCommandTarget: "Current launcher target: {path}",
	cliCommandShadowed: "Another dsh takes precedence. Remove or reorder that installation to use the Desktop command by default. You can also run the Desktop command by its full path.",
	cliCommandSelectionUnknown: "Your shell command could not be verified. An alias or another dsh installation may take precedence.",
	cliCommandInstalled: "The Desktop command is installed.",
	cliCommandNotInstalled: "Add the Desktop command to your terminal.",
	cliCommandBroken: "The Desktop command needs repair.",
	cliCommandInstall: "Install",
	cliCommandRepair: "Repair",
	cliCommandRemove: "Remove",
	cliCommandClose: "Close",
	cliCommandSwitch: "Continue with the Desktop command?",
	cliCommandPreserve: "An existing command will be preserved. Other installations and shell startup files will not be changed.",
	cliCommandContinue: "Continue",
	cliCommandInstallApp: "Install Desktop in your Applications folder before managing the dsh command.",
	cliCommandUpdating: "An update is being installed. Manage the command after installation finishes.",
	cliCommandNewTerminal: "Open a new terminal and run dsh --version.",
	cliCommandRemoved: "Desktop command registration removed.",
	cliCommandPreviousRestored: "The previous launcher has been restored.",
	cliCommandOtherKept: "Other command installations have been left in place.",
	cliCommandBackupKept: "A previous launcher is preserved at: {path}",
	cliCommandChanged: "The command or PATH changed while this dialog was open. Open Manage dsh Command again to review the current state.",
	cliCommandOwnershipError: "The command registration or backup changed. No unrelated command was removed.",
	cliCommandFailed: "The command could not be updated. Check that the application is installed and the destination is writable, then retry.",
	application: "Application",
	fileMenu: "File",
	closePage: "Close Page or Window",
	aboutMenu: "About DeepSeek Harness",
	aboutProduct: "DeepSeek Harness",
	aboutVersion: "Version V{version}",
	hideApplication: "Hide DeepSeek Harness",
	hideOtherApplications: "Hide Others",
	showAllApplications: "Show All",
	substitutionsMenu: "Substitutions",
	speechMenu: "Speech",
	quitApplication: "Quit DeepSeek Harness",
	openApplication: "Open DeepSeek Harness",
	quit: "Quit",
	cancel: "Cancel",
	quitTitle: "Quit DeepSeek Harness?",
	quitActiveTasks: "Running tasks will be interrupted.",
	quitScheduledTasks: "Scheduled tasks will not run while the app is closed.",
	quitActiveAndScheduledTasks: "Running tasks will be interrupted, and scheduled tasks will not run while the app is closed.",
	backgroundNoticeBody: "Running tasks will continue. You can reopen the window from the system tray.",
	backgroundNoticeConfirm: "Confirm",
	edit: "Edit",
	menuBar: "Application menu",
	delete: "Delete",
	undo: "Undo",
	redo: "Redo",
	cut: "Cut",
	copy: "Copy",
	paste: "Paste",
	selectAll: "Select All",
	startupFailed: "DeepSeek Harness is unavailable",
	fatalSummary: "The application could not start or stopped unexpectedly.",
	startupAddressInUse: "Another DSH instance (such as dsh web or the desktop app) is running. They cannot start at the same time. Quit the other running DSH instance, then restart.",
	diagnosticTruncated: "… Error details shortened.",
	reportWrittenTo: "Diagnostic report: {path}",
	getDiagnosticReport: "Get diagnostic report",
	reportPending: "The diagnostic report is still being saved. Choose Get diagnostic report to check again.",
	reportUnavailable: "The diagnostic report could not be saved. You can provide a screenshot of this dialog when requesting support.",
	reportShareHint: "The report location has been opened. Attach the selected file to your support ticket.",
	reportRevealFailed: "The report location could not be opened. Use the path below to find the file.",
	startupReinstallAdvice: "If application files are missing or damaged, close the application and reinstall it. Your tasks are stored separately.",
	exitApplication: "Exit",
	restartApplication: "Restart",
	recoveryOperationFailed: "The recovery operation failed",
	disableThirdPartyPlugins: "Disable third-party plugins, back up profile patch, and restart",
	welcomeTitle: "DeepSeek Harness",
	welcomeBrand: "DeepSeek Harness",
	welcomeTaglineBefore: "Welcome to ",
	welcomeTaglineBrand: "DeepSeek Harness",
	welcomeTaglineAfter: "",
	welcomeDescription: "Build potential. Explore intelligence.",
	welcomeAuthStarting: "Opening sign in…",
	welcomeAuthWaiting: "Browser didn’t open automatically?",
	welcomeAuthWaitingDescription: "Copy the sign-in link and open it in your browser to sign in.",
	welcomeAuthExchanging: "Completing sign in…",
	welcomeAuthExpired: "Sign in timed out",
	welcomeAuthExpiredDescription: "Sign in again to continue",
	welcomeAuthFailed: "Could not complete sign in. Please try again.",
	welcomeAuthCopyLink: "Copy sign-in link",
	welcomeAuthCopied: "Copied",
	welcomeAuthCopyFailed: "Could not copy. Try again.",
	welcomeAuthCancel: "Cancel",
	welcomeAuthRetry: "Sign in again",
	welcomeSignIn: "Sign in",
	welcomeApiKey: "Add API Key",
	welcomeKeyTitle: "Add an API key to get started",
	welcomeKeyDescription: "Configure official DeepSeek models to start using Harness",
	welcomeKeyPlaceholder: "Enter API key",
	welcomeKeySave: "Save and continue",
	welcomeKeyLater: "Set up later",
	welcomeKeyBack: "Back to sign in",
	welcomeSessionExpired: "You have signed out of your account, please log in again.",
	welcomeKeyBlank: "Enter an API key.",
	welcomeKeyInvalid: "Enter the API key itself, without quotes, spaces, or an environment-variable assignment.",
	welcomeKeyFailed: "Could not save the API key. Please try again.",
	welcomeContinueFailed: "Could not open the workspace. Please try again.",
	checkUpdatesMenu: "Check for Updates…",
	reloadPageMenu: "Reload Page",
	toggleDevToolsMenu: "Developer tools",
	restartAppHostMenu: "Restart App and Host",
	updateConfigurationFailed: "Update settings could not be applied. Fix the configuration file and restart, or select an update channel in Settings.",
	updateConfigurationRead: "Settings file error; updates are paused",
	updateConfigurationFormat: "Settings file error; updates are paused",
	updateConfigurationChannel: "Settings file error; updates are paused",
	updateConfigurationCleanup: "Updates paused: cannot discard previous update; restart the app",
	updateReloadSettings: "Reload settings",
	updateConfigurationDetails: "Review settings",
	updateShowSettingsFile: "Show settings file",
	updateCheckFailedTitle: "Update Check Failed",
	updateCheckFailed: "Could not check for updates. Please try again later.",
	updateDownloadFailed: "Could not download the update. Please try again.",
	updateDownloadSpaceFailed: "Not enough disk space to download the update. Free up space, then retry.",
	updateDownloadPermissionFailed: "Cannot write the update files. Check the folder permissions and retry.",
	updateDownloadBusyFailed: "An update file is in use. Close the program using it, then retry.",
	updateInstallFailed: "Could not install the update. Please try again later.",
	updateCheckNetworkFailed: "Could not check for updates. Check your connection and try again.",
	updateDownloadNetworkFailed: "Could not download the update. Check your connection and try again.",
	updateInstallNetworkFailed: "Could not install the update. Check your connection and try again.",
	unknownError: "Unknown error",
	updateCheckTitle: "Check for Updates",
	updateCurrentDetail: "Current version: {version}",
	updateCurrent: "You’re up to date!",
	updateChecking: "Checking for updates…",
	updateDownload: "Download update",
	updateDownloadedTitle: "Version {version} is ready to install",
	updateDownloadedDetail: "The app will close during the update and reopen automatically when it is complete.",
	updateDownloadedDetailWindows: "The app will close temporarily during the update and reopen automatically when it is complete.\n\nThe update may take some time. Please wait and do not launch the app again during installation.",
	updateClose: "Close",
	updateAcknowledge: "OK",
	updateLater: "Update later",
	updateDownloadInProgress: "Downloading update",
	updateDownloadDetail: "The update is downloading in the background. You can continue using the app.",
	updateDownloading: "Downloading {percent}%…",
	updateVerifying: "Verifying update files…",
	updateInstalling: "Preparing to restart…",
	updateRetry: "Retry update",
	updateActiveTasks: "Tasks are still in progress",
	updateActiveTasksDetail: "Updating will stop the tasks in progress and restart the app. Continue?",
	updateStopTasks: "Stop tasks and update",
	updateTasksChanged: "New tasks have started. Confirm again to stop the tasks and update.",
	updateTasksUnavailable: "Task status is unavailable. Try updating again when the workspace is ready.",
	updateFullscreenTimeout: "Could not exit fullscreen. Exit fullscreen, then retry the update.",
	updateStopFailed: "Could not safely stop the tasks. The update has not been installed. Please try again later.",
	updateTechnicalDetails: "View technical details",
	updateTitle: "DeepSeek Harness Update",
	updateAvailable: "New version available: {version}",
	updateDetail: "Once the download is complete, you can install the update and restart the app.",
	installAndRestart: "Install and Restart",
	later: "Later",
	updateFailedTitle: "Update Failed",
	mandatoryTitle: "Update to continue",
	mandatoryDetail: "This version is no longer supported. Update to continue. Tasks in progress will keep running until you confirm installation and restart.",
	mandatoryUnavailable: "Could not check update requirements. Please try again later.",
	policyLoginTitle: "Sign in to the test environment",
	policyLoginRequired: "Sign in with Feishu to check update requirements for this test build. Signing in will not download or install an update.",
	policyLogin: "Sign in with Feishu",
	policyLoginFailed: "Feishu sign-in did not complete. Please try again.",
	policyLoginLoading: "Loading sign-in page…",
	mandatoryNoRelease: "No compatible update was found. Check again or contact support.",
	mandatoryRefresh: "Check again",
	mandatoryPage: "Download from the official website",
	mandatoryCopy: "Copy download link",
	mandatoryPageFailed: "Could not open the official download page. Copy the link and open it in your browser.",
	mandatoryViewDownload: "Open download page",
	mandatoryViewPageFailed: "Could not open the download page. Please try again.",
	mandatoryActionFailed: "The action failed. Please try again. You can use the app again after the update is complete.",
	mandatoryReady: "Update ready",
	mandatoryVersion: "New version: {version}",
	mandatoryReadyDetail: "The app will close during the update and reopen automatically when it is complete.",
	mandatoryDeferred: "Tasks in progress will keep running. Complete the update before using the app again.",
	mandatoryContinue: "Continue update",
	mandatoryInspecting: "Checking tasks…",
	mandatoryStopping: "Stopping tasks…",
	mandatoryRestarting: "The app will restart shortly. Please wait.",
	mandatoryDownloadFailed: "The update files could not be downloaded or prepared. Please retry.",
	mandatoryInstallFailed: "The update has not been installed. Check the tasks again and retry.",
	mandatoryOpenHelp: "Page didn’t open?",
	mandatoryReopen: "Open the official download page again",
	mandatoryCopied: "Link copied",
	mandatoryCopyFailed: "Could not copy the link. Select and copy it below.",
	mandatoryAddress: "Download link",
	mandatoryNotification: "Return to the application to confirm installation and restart."
};
const dictionaries = {
	en,
	zh: {
		cliCommandMenu: "管理 dsh 命令…",
		cliCommandTitle: "管理 dsh 命令",
		cliCommandLocation: "Desktop 命令：{path}",
		cliCommandSelected: "当前 dsh 命令：{path}",
		cliCommandTarget: "当前启动器目标：{path}",
		cliCommandShadowed: "另一个 dsh 的优先级更高。请移除或调整该安装的顺序，以默认使用 Desktop 命令；也可以通过完整路径运行 Desktop 命令。",
		cliCommandSelectionUnknown: "无法确认 shell 中的命令。别名或另一个 dsh 安装可能具有更高优先级。",
		cliCommandInstalled: "Desktop 命令已安装。",
		cliCommandNotInstalled: "将 Desktop 命令添加到终端。",
		cliCommandBroken: "Desktop 命令需要修复。",
		cliCommandInstall: "安装",
		cliCommandRepair: "修复",
		cliCommandRemove: "移除",
		cliCommandClose: "关闭",
		cliCommandSwitch: "继续使用 Desktop 命令？",
		cliCommandPreserve: "现有命令会被保留，不会修改其他安装或 shell 启动文件。",
		cliCommandContinue: "继续",
		cliCommandInstallApp: "请先将 Desktop 安装到“应用程序”文件夹，再管理 dsh 命令。",
		cliCommandUpdating: "正在安装更新。请在安装完成后管理命令。",
		cliCommandNewTerminal: "打开新终端并运行 dsh --version。",
		cliCommandRemoved: "已移除 Desktop 命令注册。",
		cliCommandPreviousRestored: "已恢复之前的启动器。",
		cliCommandOtherKept: "其他命令安装保持不变。",
		cliCommandBackupKept: "之前的启动器保留在：{path}",
		cliCommandChanged: "对话框打开期间命令或 PATH 已改变。请重新打开“管理 dsh 命令”检查当前状态。",
		cliCommandOwnershipError: "命令注册或备份已改变，未移除无关命令。",
		cliCommandFailed: "无法更新命令。请检查应用是否已安装、目标位置是否可写，然后重试。",
		application: "应用",
		fileMenu: "文件",
		closePage: "关闭页面或窗口",
		aboutMenu: "关于 DeepSeek Harness",
		aboutProduct: "DeepSeek Harness",
		aboutVersion: "版本 V{version}",
		hideApplication: "隐藏 DeepSeek Harness",
		hideOtherApplications: "隐藏其他",
		showAllApplications: "显示全部",
		substitutionsMenu: "替换",
		speechMenu: "语音",
		quitApplication: "退出 DeepSeek Harness",
		openApplication: "打开 DeepSeek Harness",
		quit: "退出",
		cancel: "取消",
		quitTitle: "退出 DeepSeek Harness？",
		quitActiveTasks: "当前正在运行的任务将会中断",
		quitScheduledTasks: "应用关闭期间，定时任务不会运行",
		quitActiveAndScheduledTasks: "当前正在运行的任务将会中断，且应用关闭期间，定时任务不会运行",
		backgroundNoticeBody: "正在运行的任务不会中断，可在系统托盘中重新打开窗口",
		backgroundNoticeConfirm: "确认",
		edit: "编辑",
		menuBar: "应用菜单",
		delete: "删除",
		undo: "撤销",
		redo: "重做",
		cut: "剪切",
		copy: "复制",
		paste: "粘贴",
		selectAll: "全选",
		startupFailed: "DeepSeek Harness 无法使用",
		fatalSummary: "应用无法启动或已意外停止。",
		startupAddressInUse: "有其他正在运行的 DSH（如其他 dsh web、桌面端），无法同时启动，请退出其他正在运行的 DSH 后重启。",
		diagnosticTruncated: "… 错误详情已截短。",
		reportWrittenTo: "诊断报告：{path}",
		getDiagnosticReport: "获取诊断报告",
		reportPending: "诊断报告仍在保存，可点击“获取诊断报告”再次检查。",
		reportUnavailable: "诊断报告未能保存，反馈问题时可提供此窗口的截图。",
		reportShareHint: "已打开报告位置，请将选中的文件附在支持工单中。",
		reportRevealFailed: "无法打开报告位置，请通过下方路径查找文件。",
		startupReinstallAdvice: "如果应用文件缺失或损坏，请关闭应用并重新安装。任务数据存储在独立位置。",
		exitApplication: "退出",
		restartApplication: "重启",
		recoveryOperationFailed: "恢复操作失败",
		disableThirdPartyPlugins: "禁用第三方插件、备份 profile patch 并重启",
		welcomeTitle: "DeepSeek Harness",
		welcomeBrand: "DeepSeek Harness",
		welcomeTaglineBefore: "欢迎使用 ",
		welcomeTaglineBrand: "DeepSeek Harness",
		welcomeTaglineAfter: "",
		welcomeDescription: "组装无限可能，共探智能上限",
		welcomeAuthStarting: "正在打开登录…",
		welcomeAuthWaiting: "没有自动打开浏览器？",
		welcomeAuthWaitingDescription: "复制登录链接，用浏览器手动打开完成登录",
		welcomeAuthExchanging: "正在完成登录…",
		welcomeAuthExpired: "登录已超时",
		welcomeAuthExpiredDescription: "请重新登录后继续操作",
		welcomeAuthFailed: "登录未完成，请重试。",
		welcomeAuthCopyLink: "复制登录链接",
		welcomeAuthCopied: "已复制",
		welcomeAuthCopyFailed: "复制失败，请重试",
		welcomeAuthCancel: "取消",
		welcomeAuthRetry: "重新登录",
		welcomeSignIn: "登录",
		welcomeApiKey: "添加 API Key",
		welcomeKeyTitle: "添加一个 API Key 开始使用",
		welcomeKeyDescription: "配置 DeepSeek 官方模型，即可开始使用",
		welcomeKeyPlaceholder: "输入 API 密钥",
		welcomeKeySave: "保存并继续",
		welcomeKeyLater: "稍后配置",
		welcomeKeyBack: "返回登录",
		welcomeSessionExpired: "登录信息已失效，请重新登录",
		welcomeKeyBlank: "请输入 API 密钥。",
		welcomeKeyInvalid: "请仅输入 API 密钥，不要包含引号、空格或环境变量赋值。",
		welcomeKeyFailed: "无法保存 API 密钥，请重试。",
		welcomeContinueFailed: "无法打开工作区，请重试。",
		checkUpdatesMenu: "检查更新…",
		reloadPageMenu: "刷新页面",
		toggleDevToolsMenu: "开发者工具",
		restartAppHostMenu: "重启应用与 Host",
		updateConfigurationFailed: "更新配置无法应用。请修正配置文件并重启，或在设置中选择更新渠道。",
		updateConfigurationRead: "配置文件异常，更新已暂停",
		updateConfigurationFormat: "配置文件异常，更新已暂停",
		updateConfigurationChannel: "配置文件异常，更新已暂停",
		updateConfigurationCleanup: "更新已暂停：无法清理旧更新，请重启应用",
		updateReloadSettings: "重新读取配置",
		updateConfigurationDetails: "查看配置",
		updateShowSettingsFile: "显示配置文件",
		updateCheckFailedTitle: "更新检查失败",
		updateCheckFailed: "检查更新失败，请稍后重试。",
		updateDownloadFailed: "下载更新失败，请重试。",
		updateDownloadSpaceFailed: "磁盘空间不足，无法下载更新。请释放空间后重试。",
		updateDownloadPermissionFailed: "无法写入更新文件，请检查目录权限后重试。",
		updateDownloadBusyFailed: "更新文件正被占用，请关闭占用它的程序后重试。",
		updateInstallFailed: "安装更新失败，请稍后重试。",
		updateCheckNetworkFailed: "检查更新失败，请检查网络连接后重试。",
		updateDownloadNetworkFailed: "下载更新失败，请检查网络连接后重试。",
		updateInstallNetworkFailed: "安装更新失败，请检查网络连接后重试。",
		unknownError: "未知错误",
		updateCheckTitle: "检查更新",
		updateCurrentDetail: "当前版本：{version}",
		updateCurrent: "已是最新版本",
		updateChecking: "正在检查更新…",
		updateDownload: "下载更新",
		updateDownloadedTitle: "新版本 {version} 已准备就绪",
		updateDownloadedDetail: "更新期间应用将暂时关闭，完成后会自动打开。",
		updateDownloadedDetailWindows: "更新期间应用将暂时关闭，完成后会自动打开。\n\n更新可能需要一些时间，请耐心等待，期间请勿重复启动应用。",
		updateClose: "关闭",
		updateAcknowledge: "确定",
		updateLater: "稍后更新",
		updateDownloadInProgress: "正在下载更新",
		updateDownloadDetail: "更新正在后台下载，你可以继续使用应用。",
		updateDownloading: "正在下载 {percent}%…",
		updateVerifying: "正在校验更新文件…",
		updateInstalling: "正在准备重启…",
		updateRetry: "重试更新",
		updateActiveTasks: "仍有进行中的任务",
		updateActiveTasksDetail: "更新将停止进行中的任务并重启应用，是否继续？",
		updateStopTasks: "停止任务并更新",
		updateTasksChanged: "有新任务开始运行，请重新确认是否停止任务并更新。",
		updateTasksUnavailable: "无法确认任务状态，请在工作区就绪后重试更新。",
		updateFullscreenTimeout: "无法退出全屏，请退出全屏后重试更新",
		updateStopFailed: "未能安全停止任务，更新尚未安装，请稍后重试。",
		updateTechnicalDetails: "查看技术详情",
		updateTitle: "DeepSeek Harness 更新",
		updateAvailable: "发现新版本 {version}",
		updateDetail: "下载完成后，可安装并重启应用。",
		installAndRestart: "安装并重启",
		later: "稍后",
		updateFailedTitle: "更新失败",
		mandatoryTitle: "请更新后继续使用",
		mandatoryDetail: "当前版本已停止支持，请更新后继续使用。确认安装并重启前，进行中的任务会继续运行。",
		mandatoryUnavailable: "暂时无法检查更新要求，请稍后重试。",
		policyLoginTitle: "登录测试环境",
		policyLoginRequired: "此测试版需要先通过飞书登录，才能检查更新要求。登录不会下载或安装更新。",
		policyLogin: "通过飞书登录",
		policyLoginFailed: "飞书登录未完成，请重试。",
		policyLoginLoading: "正在加载登录页面…",
		mandatoryNoRelease: "暂未找到适用的更新，请重新检查或联系支持人员。",
		mandatoryRefresh: "重新检查",
		mandatoryPage: "前往官网下载",
		mandatoryCopy: "复制下载链接",
		mandatoryPageFailed: "无法打开官网下载页面，请复制链接后在浏览器中打开。",
		mandatoryViewDownload: "打开下载页面",
		mandatoryViewPageFailed: "无法打开下载页面，请重试",
		mandatoryActionFailed: "操作失败，请重试。完成更新后才能继续使用应用。",
		mandatoryReady: "更新已准备就绪",
		mandatoryVersion: "新版本：{version}",
		mandatoryReadyDetail: "更新期间应用将暂时关闭，完成后会自动打开。",
		mandatoryDeferred: "进行中的任务会继续运行。请完成更新后再操作应用。",
		mandatoryContinue: "继续更新",
		mandatoryInspecting: "正在检查任务状态…",
		mandatoryStopping: "正在停止任务…",
		mandatoryRestarting: "应用即将重启，请稍候。",
		mandatoryDownloadFailed: "更新文件下载或准备失败，请重试。",
		mandatoryInstallFailed: "更新尚未安装，请重新检查任务后重试。",
		mandatoryOpenHelp: "页面未打开？",
		mandatoryReopen: "重新前往官网下载",
		mandatoryCopied: "链接已复制",
		mandatoryCopyFailed: "复制失败，请手动选择并复制下方链接。",
		mandatoryAddress: "下载链接",
		mandatoryNotification: "返回应用确认安装并重启。"
	},
	ja: {
		cliCommandMenu: "dsh コマンドを管理…",
		cliCommandTitle: "dsh コマンドを管理",
		cliCommandLocation: "デスクトップコマンド: {path}",
		cliCommandSelected: "現在の dsh コマンド: {path}",
		cliCommandTarget: "現在のランチャーターゲット: {path}",
		cliCommandShadowed: "別の dsh が優先されています。デフォルトでデスクトップコマンドを使用するには、そのインストールを削除するか順序を変更してください。デスクトップコマンドはフルパスでも実行できます。",
		cliCommandSelectionUnknown: "シェルコマンドを確認できませんでした。エイリアスや別の dsh インストールが優先されている可能性があります。",
		cliCommandInstalled: "デスクトップコマンドがインストールされています。",
		cliCommandNotInstalled: "デスクトップコマンドをターミナルに追加します。",
		cliCommandBroken: "デスクトップコマンドの修復が必要です。",
		cliCommandInstall: "インストール",
		cliCommandRepair: "修復",
		cliCommandRemove: "削除",
		cliCommandClose: "閉じる",
		cliCommandSwitch: "デスクトップコマンドで続行しますか？",
		cliCommandPreserve: "既存のコマンドは保持されます。他のインストールやシェルの起動ファイルは変更されません。",
		cliCommandContinue: "続行",
		cliCommandInstallApp: "dsh コマンドを管理する前に、デスクトップをアプリケーションフォルダにインストールしてください。",
		cliCommandUpdating: "アップデートをインストール中です。インストール完了後にコマンドを管理してください。",
		cliCommandNewTerminal: "新しいターミナルを開いて dsh --version を実行してください。",
		cliCommandRemoved: "デスクトップコマンドの登録を削除しました。",
		cliCommandPreviousRestored: "以前のランチャーを復元しました。",
		cliCommandOtherKept: "他のコマンドインストールはそのまま残されています。",
		cliCommandBackupKept: "以前のランチャーは次の場所に保持されています: {path}",
		cliCommandChanged: "このダイアログを開いている間にコマンドまたは PATH が変更されました。現在の状態を確認するには、dsh コマンドを管理を再度開いてください。",
		cliCommandOwnershipError: "コマンド登録またはバックアップが変更されました。無関係なコマンドは削除されていません。",
		cliCommandFailed: "コマンドを更新できませんでした。アプリケーションがインストールされ、保存先に書き込み権限があることを確認してから再試行してください。",
		application: "アプリケーション",
		fileMenu: "ファイル",
		closePage: "ページまたはウィンドウを閉じる",
		aboutMenu: "DeepSeek Harness について",
		aboutProduct: "DeepSeek Harness",
		aboutVersion: "バージョン V{version}",
		hideApplication: "DeepSeek Harness を隠す",
		hideOtherApplications: "ほかを隠す",
		showAllApplications: "すべて表示",
		substitutionsMenu: "自動置換",
		speechMenu: "スピーチ",
		quitApplication: "DeepSeek Harness を終了",
		openApplication: "DeepSeek Harness を開く",
		quit: "終了",
		cancel: "キャンセル",
		quitTitle: "DeepSeek Harness を終了しますか？",
		quitActiveTasks: "実行中のタスクは中断されます。",
		quitScheduledTasks: "アプリの終了中はスケジュールされたタスクが実行されません。",
		quitActiveAndScheduledTasks: "実行中のタスクは中断され、アプリの終了中はスケジュールされたタスクが実行されません。",
		backgroundNoticeBody: "実行中のタスクは継続されます。システムトレイからウィンドウを再度開けます。",
		backgroundNoticeConfirm: "確認",
		edit: "編集",
		menuBar: "アプリケーションメニュー",
		delete: "削除",
		undo: "元に戻す",
		redo: "やり直す",
		cut: "切り取り",
		copy: "コピー",
		paste: "貼り付け",
		selectAll: "すべて選択",
		startupFailed: "DeepSeek Harness を利用できません",
		fatalSummary: "アプリケーションを起動できなかったか、予期せず停止しました。",
		startupAddressInUse: "別の DSH インスタンス (dsh web やデスクトップアプリなど) が実行中です。同時に起動することはできません。実行中の他の DSH インスタンスを終了してから再起動してください。",
		diagnosticTruncated: "… エラー詳細は省略されています。",
		reportWrittenTo: "診断レポート: {path}",
		getDiagnosticReport: "診断レポートを取得",
		reportPending: "診断レポートを保存中です。「診断レポートを取得」を選択して再度確認してください。",
		reportUnavailable: "診断レポートを保存できませんでした。サポートへのお問い合わせ時に、このダイアログのスクリーンショットを提供できます。",
		reportShareHint: "レポートの保存場所を開きました。選択されたファイルをサポートチケットに添付してください。",
		reportRevealFailed: "レポートの保存場所を開けませんでした。以下のパスからファイルを探してください。",
		startupReinstallAdvice: "アプリケーションファイルが見つからないか破損している場合は、アプリケーションを閉じて再インストールしてください。タスクは別途保存されています。",
		exitApplication: "終了",
		restartApplication: "再起動",
		recoveryOperationFailed: "復旧操作に失敗しました",
		disableThirdPartyPlugins: "サードパーティのプラグインを無効化し、プロファイルパッチをバックアップして再起動",
		welcomeTitle: "DeepSeek Harness",
		welcomeBrand: "DeepSeek Harness",
		welcomeTaglineBefore: "ようこそ ",
		welcomeTaglineBrand: "DeepSeek Harness",
		welcomeTaglineAfter: "",
		welcomeDescription: "可能性を築く。知能を探求する。",
		welcomeAuthStarting: "ログインを開いています…",
		welcomeAuthWaiting: "ブラウザが自動で開きませんでしたか？",
		welcomeAuthWaitingDescription: "ログインリンクをコピーしてブラウザで開き、ログインしてください。",
		welcomeAuthExchanging: "ログインを完了しています…",
		welcomeAuthExpired: "ログインがタイムアウトしました",
		welcomeAuthExpiredDescription: "続行するには再度ログインしてください",
		welcomeAuthFailed: "ログインを完了できませんでした。もう一度お試しください。",
		welcomeAuthCopyLink: "ログインリンクをコピー",
		welcomeAuthCopied: "コピーしました",
		welcomeAuthCopyFailed: "コピーできませんでした。もう一度お試しください。",
		welcomeAuthCancel: "キャンセル",
		welcomeAuthRetry: "再度ログイン",
		welcomeSignIn: "ログイン",
		welcomeApiKey: "APIキーを追加",
		welcomeKeyTitle: "APIキーを追加して開始",
		welcomeKeyDescription: "公式のDeepSeekモデルを設定してHarnessを使い始めましょう",
		welcomeKeyPlaceholder: "APIキーを入力",
		welcomeKeySave: "保存して続行",
		welcomeKeyLater: "後で設定",
		welcomeKeyBack: "ログインに戻る",
		welcomeSessionExpired: "アカウントからログアウトしました。再度ログインしてください。",
		welcomeKeyBlank: "APIキーを入力してください。",
		welcomeKeyInvalid: "引用符、スペース、環境変数の代入を含めず、APIキーそのものを入力してください。",
		welcomeKeyFailed: "APIキーを保存できませんでした。もう一度お試しください。",
		welcomeContinueFailed: "ワークスペースを開けませんでした。もう一度お試しください。",
		checkUpdatesMenu: "アップデートを確認…",
		reloadPageMenu: "ページを再読み込み",
		toggleDevToolsMenu: "開発者ツール",
		restartAppHostMenu: "アプリとホストを再起動",
		updateConfigurationFailed: "更新設定を適用できませんでした。設定ファイルを修正して再起動するか、設定で更新チャンネルを選択してください。",
		updateConfigurationRead: "設定ファイルに問題があるため、更新を停止しています",
		updateConfigurationFormat: "設定ファイルに問題があるため、更新を停止しています",
		updateConfigurationChannel: "設定ファイルに問題があるため、更新を停止しています",
		updateConfigurationCleanup: "更新を停止中：以前の更新を削除できません。アプリを再起動してください",
		updateReloadSettings: "設定を再読み込み",
		updateConfigurationDetails: "設定を確認",
		updateShowSettingsFile: "設定ファイルを表示",
		updateCheckFailedTitle: "アップデートの確認に失敗しました",
		updateCheckFailed: "アップデートを確認できませんでした。後でもう一度お試しください。",
		updateDownloadFailed: "アップデートをダウンロードできませんでした。もう一度お試しください。",
		updateDownloadSpaceFailed: "更新のダウンロードに必要なディスク容量が不足しています。空き容量を増やして再試行してください。",
		updateDownloadPermissionFailed: "更新ファイルを書き込めません。フォルダーのアクセス権を確認して再試行してください。",
		updateDownloadBusyFailed: "更新ファイルが使用中です。使用しているプログラムを閉じて再試行してください。",
		updateInstallFailed: "アップデートをインストールできませんでした。後でもう一度お試しください。",
		updateCheckNetworkFailed: "アップデートを確認できませんでした。接続を確認してもう一度お試しください。",
		updateDownloadNetworkFailed: "アップデートをダウンロードできませんでした。接続を確認してもう一度お試しください。",
		updateInstallNetworkFailed: "アップデートをインストールできませんでした。接続を確認してもう一度お試しください。",
		unknownError: "不明なエラー",
		updateCheckTitle: "アップデートを確認",
		updateCurrentDetail: "現在のバージョン: {version}",
		updateCurrent: "最新です！",
		updateChecking: "アップデートを確認中…",
		updateDownload: "アップデートをダウンロード",
		updateDownloadedTitle: "バージョン {version} をインストールする準備ができました",
		updateDownloadedDetail: "アップデート中はアプリが終了し、完了後に自動的に再起動します。",
		updateDownloadedDetailWindows: "アップデート中はアプリが一時的に終了し、完了後に自動的に再起動します。\n\nアップデートには時間がかかる場合があります。インストール中はアプリを再度起動せずにお待ちください。",
		updateClose: "閉じる",
		updateAcknowledge: "OK",
		updateLater: "後でアップデート",
		updateDownloadInProgress: "アップデートをダウンロード中",
		updateDownloadDetail: "アップデートをバックグラウンドでダウンロードしています。アプリは引き続き使用できます。",
		updateDownloading: "ダウンロード中 {percent}%…",
		updateVerifying: "アップデートファイルを検証中…",
		updateInstalling: "再起動の準備中…",
		updateRetry: "アップデートを再試行",
		updateActiveTasks: "タスクがまだ実行中です",
		updateActiveTasksDetail: "アップデートすると実行中のタスクが停止し、アプリが再起動します。続行しますか？",
		updateStopTasks: "タスクを停止してアップデート",
		updateTasksChanged: "新しいタスクが開始されました。タスクを停止してアップデートするには再度確認してください。",
		updateTasksUnavailable: "タスクの状態を取得できません。ワークスペースの準備ができてから再度アップデートをお試しください。",
		updateFullscreenTimeout: "フルスクリーンを終了できませんでした。フルスクリーンを終了してからアップデートを再試行してください。",
		updateStopFailed: "タスクを安全に停止できませんでした。アップデートはインストールされていません。後でもう一度お試しください。",
		updateTechnicalDetails: "技術的な詳細を表示",
		updateTitle: "DeepSeek Harness アップデート",
		updateAvailable: "新しいバージョンがあります: {version}",
		updateDetail: "ダウンロードが完了したら、アップデートをインストールしてアプリを再起動できます。",
		installAndRestart: "インストールして再起動",
		later: "後で",
		updateFailedTitle: "アップデートに失敗しました",
		mandatoryTitle: "続行するにはアップデートしてください",
		mandatoryDetail: "このバージョンはサポートされなくなりました。続行するにはアップデートしてください。実行中のタスクは、インストールの確認と再起動を行うまで実行を継続します。",
		mandatoryUnavailable: "アップデートの要件を確認できませんでした。後でもう一度お試しください。",
		policyLoginTitle: "テスト環境にログイン",
		policyLoginRequired: "Feishuでログインして、このテストビルドのアップデート要件を確認します。ログインしてもアップデートのダウンロードやインストールは行われません。",
		policyLogin: "Feishuでログイン",
		policyLoginFailed: "Feishuのログインが完了しませんでした。もう一度お試しください。",
		policyLoginLoading: "ログインページを読み込み中…",
		mandatoryNoRelease: "互換性のあるアップデートが見つかりませんでした。再度確認するか、サポートにお問い合わせください。",
		mandatoryRefresh: "再確認",
		mandatoryPage: "公式サイトからダウンロード",
		mandatoryCopy: "ダウンロードリンクをコピー",
		mandatoryPageFailed: "公式ダウンロードページを開けませんでした。リンクをコピーしてブラウザで開いてください。",
		mandatoryViewDownload: "ダウンロードページを開く",
		mandatoryViewPageFailed: "ダウンロードページを開けませんでした。もう一度お試しください。",
		mandatoryActionFailed: "操作に失敗しました。もう一度お試しください。アップデートが完了すると、アプリを再度使用できます。",
		mandatoryReady: "アップデートの準備完了",
		mandatoryVersion: "新しいバージョン: {version}",
		mandatoryReadyDetail: "アップデート中にアプリが終了し、完了後に自動的に再起動します。",
		mandatoryDeferred: "実行中のタスクはそのまま続行されます。アプリを再度使用する前にアップデートを完了してください。",
		mandatoryContinue: "アップデートを続行",
		mandatoryInspecting: "タスクを確認中…",
		mandatoryStopping: "タスクを停止中…",
		mandatoryRestarting: "まもなくアプリが再起動します。しばらくお待ちください。",
		mandatoryDownloadFailed: "アップデートファイルをダウンロードまたは準備できませんでした。再試行してください。",
		mandatoryInstallFailed: "アップデートはインストールされていません。タスクを再度確認して再試行してください。",
		mandatoryOpenHelp: "ページが開きませんでしたか？",
		mandatoryReopen: "公式ダウンロードページを再度開く",
		mandatoryCopied: "リンクをコピーしました",
		mandatoryCopyFailed: "リンクをコピーできませんでした。以下から選択してコピーしてください。",
		mandatoryAddress: "ダウンロードリンク",
		mandatoryNotification: "アプリに戻り、インストールと再起動を確認してください。"
	},
	es: {
		cliCommandMenu: "Administrar el comando dsh…",
		cliCommandTitle: "Administrar el comando dsh",
		cliCommandLocation: "Comando de escritorio: {path}",
		cliCommandSelected: "Comando dsh actual: {path}",
		cliCommandTarget: "Objetivo actual del lanzador: {path}",
		cliCommandShadowed: "Otro dsh tiene prioridad. Elimine o reordene esa instalación para usar el comando Escritorio de forma predeterminada. También puede ejecutar el comando Escritorio por su ruta completa.",
		cliCommandSelectionUnknown: "No se pudo verificar su comando de shell. Un alias u otra instalación de dsh puede tener prioridad.",
		cliCommandInstalled: "El comando Escritorio está instalado.",
		cliCommandNotInstalled: "Agregue el comando Escritorio a su terminal.",
		cliCommandBroken: "El comando de escritorio necesita reparación.",
		cliCommandInstall: "Instalar",
		cliCommandRepair: "Reparación",
		cliCommandRemove: "Quitar",
		cliCommandClose: "Cerrar",
		cliCommandSwitch: "¿Continuar con el comando Escritorio?",
		cliCommandPreserve: "Se conservará un comando existente. Otras instalaciones y archivos de inicio del shell no se modificarán.",
		cliCommandContinue: "Continuar",
		cliCommandInstallApp: "Instale Desktop en su carpeta de Aplicaciones antes de administrar el comando dsh.",
		cliCommandUpdating: "Se está instalando una actualización. Administre el comando una vez finalizada la instalación.",
		cliCommandNewTerminal: "Abra una nueva terminal y ejecute dsh --version.",
		cliCommandRemoved: "Se eliminó el registro de comandos de escritorio.",
		cliCommandPreviousRestored: "El lanzador anterior ha sido restaurado.",
		cliCommandOtherKept: "Otras instalaciones de mando se han dejado en su lugar.",
		cliCommandBackupKept: "Se conserva un lanzador anterior en: {path}",
		cliCommandChanged: "El comando o RUTA cambió mientras este cuadro de diálogo estaba abierto. Abra Administrar comando dsh nuevamente para revisar el estado actual.",
		cliCommandOwnershipError: "El registro del comando o la copia de seguridad cambió. No se eliminó ningún comando no relacionado.",
		cliCommandFailed: "El comando no se pudo actualizar. Verifique que la aplicación esté instalada y que se pueda escribir en el destino, luego vuelva a intentarlo.",
		application: "Solicitud",
		fileMenu: "Archivo",
		closePage: "Cerrar página o ventana",
		aboutMenu: "Acerca de DeepSeek Harness",
		aboutProduct: "DeepSeek Harness",
		aboutVersion: "Versión V{version}",
		hideApplication: "Ocultar DeepSeek Harness",
		hideOtherApplications: "Ocultar otros",
		showAllApplications: "Mostrar todo",
		substitutionsMenu: "Sustituciones",
		speechMenu: "Voz",
		quitApplication: "Salir de DeepSeek Harness",
		openApplication: "Abrir DeepSeek Harness",
		quit: "Salir",
		cancel: "Cancelar",
		quitTitle: "¿Salir de DeepSeek Harness?",
		quitActiveTasks: "Las tareas en ejecución se interrumpirán.",
		quitScheduledTasks: "Las tareas programadas no se ejecutarán mientras la aplicación esté cerrada.",
		quitActiveAndScheduledTasks: "Las tareas en ejecución se interrumpirán y las tareas programadas no se ejecutarán mientras la aplicación esté cerrada.",
		backgroundNoticeBody: "Las tareas en ejecución continuarán. Puede volver a abrir la ventana desde la bandeja del sistema.",
		backgroundNoticeConfirm: "Confirmar",
		edit: "Editar",
		menuBar: "Menú de aplicaciones",
		delete: "Eliminar",
		undo: "Deshacer",
		redo: "Rehacer",
		cut: "cortar",
		copy: "Copiar",
		paste: "Pegar",
		selectAll: "Seleccionar todo",
		startupFailed: "DeepSeek Harness no está disponible",
		fatalSummary: "La aplicación no pudo iniciarse o se detuvo inesperadamente.",
		startupAddressInUse: "Se está ejecutando otra instancia de DSH (como la web de dsh o la aplicación de escritorio). No pueden empezar al mismo tiempo. Salga de la otra instancia DSH en ejecución y luego reinicie.",
		diagnosticTruncated: "… Detalles del error acortados.",
		reportWrittenTo: "Informe de diagnóstico: {path}",
		getDiagnosticReport: "Obtener informe de diagnóstico",
		reportPending: "El informe de diagnóstico se está guardando. Seleccione Obtener informe de diagnóstico para volver a comprobarlo.",
		reportUnavailable: "No se pudo guardar el informe de diagnóstico. Puede proporcionar una captura de pantalla de este diálogo al solicitar asistencia.",
		reportShareHint: "Se ha abierto la ubicación del informe. Adjunte el archivo seleccionado a su solicitud de asistencia.",
		reportRevealFailed: "No se pudo abrir la ubicación del informe. Use la ruta que aparece a continuación para encontrar el archivo.",
		startupReinstallAdvice: "Si faltan archivos de la aplicación o están dañados, ciérrela y vuelva a instalarla. Sus tareas se almacenan por separado.",
		exitApplication: "Salir",
		restartApplication: "Reiniciar",
		recoveryOperationFailed: "La operación de recuperación falló",
		disableThirdPartyPlugins: "Deshabilite los complementos de terceros, haga una copia de seguridad del parche del perfil y reinicie",
		welcomeTitle: "DeepSeek Harness",
		welcomeBrand: "DeepSeek Harness",
		welcomeTaglineBefore: "Bienvenido a ",
		welcomeTaglineBrand: "DeepSeek Harness",
		welcomeTaglineAfter: "",
		welcomeDescription: "Desarrollar potencial. Explora la inteligencia.",
		welcomeAuthStarting: "Abriendo inicio de sesión…",
		welcomeAuthWaiting: "¿El navegador no se abrió automáticamente?",
		welcomeAuthWaitingDescription: "Copie el enlace de inicio de sesión y ábralo en su navegador para iniciar sesión.",
		welcomeAuthExchanging: "Completando el inicio de sesión…",
		welcomeAuthExpired: "Se agotó el tiempo de inicio de sesión",
		welcomeAuthExpiredDescription: "Inicia sesión nuevamente para continuar",
		welcomeAuthFailed: "No se pudo completar el inicio de sesión. Inténtelo de nuevo.",
		welcomeAuthCopyLink: "Copiar enlace de inicio de sesión",
		welcomeAuthCopied: "Copiado",
		welcomeAuthCopyFailed: "No se pudo copiar. Intentar otra vez.",
		welcomeAuthCancel: "Cancelar",
		welcomeAuthRetry: "Iniciar sesión nuevamente",
		welcomeSignIn: "Iniciar sesión",
		welcomeApiKey: "Agregar clave API",
		welcomeKeyTitle: "Agregue una clave API para comenzar",
		welcomeKeyDescription: "Configura los modelos oficiales DeepSeek para empezar a utilizar Harness",
		welcomeKeyPlaceholder: "Ingrese la clave API",
		welcomeKeySave: "Guardar y continuar",
		welcomeKeyLater: "Configurar más tarde",
		welcomeKeyBack: "Volver para iniciar sesión",
		welcomeSessionExpired: "Has cerrado sesión en tu cuenta, inicia sesión nuevamente.",
		welcomeKeyBlank: "Ingrese una clave API.",
		welcomeKeyInvalid: "Ingrese la clave API, sin comillas, espacios ni una asignación de variable de entorno.",
		welcomeKeyFailed: "No se pudo guardar la clave API. Por favor inténtalo de nuevo.",
		welcomeContinueFailed: "No se pudo abrir el espacio de trabajo. Por favor inténtalo de nuevo.",
		checkUpdatesMenu: "Buscar actualizaciones...",
		reloadPageMenu: "Recargar página",
		toggleDevToolsMenu: "Herramientas de desarrollo",
		restartAppHostMenu: "Reiniciar la aplicación y el host",
		updateConfigurationFailed: "No se pudo aplicar la configuración de actualización. Corrige el archivo y reinicia, o selecciona un canal en Ajustes.",
		updateConfigurationRead: "Error en el archivo de ajustes; actualizaciones pausadas",
		updateConfigurationFormat: "Error en el archivo de ajustes; actualizaciones pausadas",
		updateConfigurationChannel: "Error en el archivo de ajustes; actualizaciones pausadas",
		updateConfigurationCleanup: "Actualizaciones pausadas: no se pudo descartar la actualización anterior; reinicia la aplicación",
		updateReloadSettings: "Volver a cargar ajustes",
		updateConfigurationDetails: "Revisar ajustes",
		updateShowSettingsFile: "Mostrar archivo de ajustes",
		updateCheckFailedTitle: "Error en la comprobación de actualización",
		updateCheckFailed: "No se pudo buscar actualizaciones. Inténtelo de nuevo más tarde.",
		updateDownloadFailed: "No se pudo descargar la actualización. Por favor inténtalo de nuevo.",
		updateDownloadSpaceFailed: "No hay espacio suficiente para descargar la actualización. Libera espacio y vuelve a intentarlo.",
		updateDownloadPermissionFailed: "No se pueden escribir los archivos de actualización. Revisa los permisos de la carpeta y vuelve a intentarlo.",
		updateDownloadBusyFailed: "Un archivo de actualización está en uso. Cierra el programa que lo usa y vuelve a intentarlo.",
		updateInstallFailed: "No se pudo instalar la actualización. Inténtelo de nuevo más tarde.",
		updateCheckNetworkFailed: "No se pudo buscar actualizaciones. Comprueba tu conexión y vuelve a intentarlo.",
		updateDownloadNetworkFailed: "No se pudo descargar la actualización. Comprueba tu conexión y vuelve a intentarlo.",
		updateInstallNetworkFailed: "No se pudo instalar la actualización. Comprueba tu conexión y vuelve a intentarlo.",
		unknownError: "Error desconocido",
		updateCheckTitle: "Buscar actualizaciones",
		updateCurrentDetail: "Versión actual: {version}",
		updateCurrent: "¡Estás al día!",
		updateChecking: "Buscando actualizaciones...",
		updateDownload: "Descargar actualización",
		updateDownloadedTitle: "La versión {version} está lista para instalar.",
		updateDownloadedDetail: "La aplicación se cerrará durante la actualización y se volverá a abrir automáticamente cuando se complete.",
		updateDownloadedDetailWindows: "La aplicación se cerrará temporalmente durante la actualización y se volverá a abrir automáticamente cuando se complete.\n\nLa actualización puede tardar algún tiempo. Espere y no vuelva a iniciar la aplicación durante la instalación.",
		updateClose: "Cerrar",
		updateAcknowledge: "OK",
		updateLater: "Actualizar más tarde",
		updateDownloadInProgress: "Descargando actualización",
		updateDownloadDetail: "La actualización se está descargando en segundo plano. Puede seguir usando la aplicación.",
		updateDownloading: "Descargando {percent}%…",
		updateVerifying: "Verificando archivos de actualización...",
		updateInstalling: "Preparándose para reiniciar…",
		updateRetry: "Reintentar actualización",
		updateActiveTasks: "Las tareas aún están en progreso",
		updateActiveTasksDetail: "La actualización detendrá las tareas en curso y reiniciará la aplicación. ¿Continuar?",
		updateStopTasks: "Detener tareas y actualizar",
		updateTasksChanged: "Han comenzado nuevas tareas. Confirme nuevamente para detener las tareas y actualizar.",
		updateTasksUnavailable: "El estado de la tarea no está disponible. Intente actualizar nuevamente cuando el espacio de trabajo esté listo.",
		updateFullscreenTimeout: "No se pudo salir de la pantalla completa. Salga de la pantalla completa y luego vuelva a intentar la actualización.",
		updateStopFailed: "No se pudieron detener las tareas de forma segura. La actualización no se ha instalado. Inténtelo de nuevo más tarde.",
		updateTechnicalDetails: "Ver detalles técnicos",
		updateTitle: "Actualización DeepSeek Harness",
		updateAvailable: "Nueva versión disponible: {version}",
		updateDetail: "Una vez que se completa la descarga, puede instalar la actualización y reiniciar la aplicación.",
		installAndRestart: "Instalar y reiniciar",
		later: "Más tarde",
		updateFailedTitle: "Actualización fallida",
		mandatoryTitle: "Actualizar para continuar",
		mandatoryDetail: "Esta versión ya no es compatible. Actualiza para continuar. Las tareas en curso seguirán ejecutándose hasta que confirme la instalación y reinicie.",
		mandatoryUnavailable: "No se pudieron verificar los requisitos de actualización. Inténtelo de nuevo más tarde.",
		policyLoginTitle: "Inicie sesión en el entorno de prueba",
		policyLoginRequired: "Inicie sesión con Feishu para verificar los requisitos de actualización para esta versión de prueba. Iniciar sesión no descargará ni instalará una actualización.",
		policyLogin: "Iniciar sesión con Feishu",
		policyLoginFailed: "El inicio de sesión de Feishu no se completó. Por favor inténtalo de nuevo.",
		policyLoginLoading: "Cargando página de inicio de sesión...",
		mandatoryNoRelease: "No se encontró ninguna actualización compatible. Verifique nuevamente o comuníquese con el soporte.",
		mandatoryRefresh: "Comprobar de nuevo",
		mandatoryPage: "Descargar desde el sitio web oficial.",
		mandatoryCopy: "Copiar enlace de descarga",
		mandatoryPageFailed: "No se pudo abrir la página de descarga oficial. Copie el enlace y ábralo en su navegador.",
		mandatoryViewDownload: "Abrir página de descarga",
		mandatoryViewPageFailed: "No se pudo abrir la página de descarga. Por favor inténtalo de nuevo.",
		mandatoryActionFailed: "La acción fracasó. Por favor inténtalo de nuevo. Puede utilizar la aplicación nuevamente una vez completada la actualización.",
		mandatoryReady: "Actualización lista",
		mandatoryVersion: "Nueva versión: {version}",
		mandatoryReadyDetail: "La aplicación se cerrará durante la actualización y se volverá a abrir automáticamente cuando se complete.",
		mandatoryDeferred: "Las tareas en curso seguirán ejecutándose. Complete la actualización antes de volver a utilizar la aplicación.",
		mandatoryContinue: "Continuar actualizando",
		mandatoryInspecting: "Comprobando tareas...",
		mandatoryStopping: "Deteniendo tareas…",
		mandatoryRestarting: "La aplicación se reiniciará en breve. Espere por favor.",
		mandatoryDownloadFailed: "Los archivos de actualización no se pudieron descargar ni preparar. Vuelva a intentarlo.",
		mandatoryInstallFailed: "La actualización no se ha instalado. Verifique las tareas nuevamente y vuelva a intentarlo.",
		mandatoryOpenHelp: "¿La página no se abrió?",
		mandatoryReopen: "Abre la página de descarga oficial nuevamente.",
		mandatoryCopied: "Enlace copiado",
		mandatoryCopyFailed: "No se pudo copiar el enlace. Selecciónelo y cópielo a continuación.",
		mandatoryAddress: "Enlace de descarga",
		mandatoryNotification: "Regrese a la aplicación para confirmar la instalación y reiniciar."
	},
	fr: {
		cliCommandMenu: "Gérer la commande dsh…",
		cliCommandTitle: "Gérer la commande dsh",
		cliCommandLocation: "Commande de bureau\xA0: {path}",
		cliCommandSelected: "Commande dsh actuelle\xA0: {path}",
		cliCommandTarget: "Cible actuelle du lanceur\xA0: {path}",
		cliCommandShadowed: "Un autre dsh est prioritaire. Supprimez ou réorganisez cette installation pour utiliser la commande Bureau par défaut. Vous pouvez également exécuter la commande Desktop par son chemin complet.",
		cliCommandSelectionUnknown: "Votre commande shell n'a pas pu être vérifiée. Un alias ou une autre installation dsh peut être prioritaire.",
		cliCommandInstalled: "La commande Bureau est installée.",
		cliCommandNotInstalled: "Ajoutez la commande Bureau à votre terminal.",
		cliCommandBroken: "La commande Bureau doit être réparée.",
		cliCommandInstall: "Installer",
		cliCommandRepair: "Réparer",
		cliCommandRemove: "Supprimer",
		cliCommandClose: "Fermer",
		cliCommandSwitch: "Continuer avec la commande Bureau\xA0?",
		cliCommandPreserve: "Une commande existante sera conservée. Les autres installations et fichiers de démarrage du shell ne seront pas modifiés.",
		cliCommandContinue: "Continuer",
		cliCommandInstallApp: "Installez Desktop dans votre dossier Applications avant de gérer la commande dsh.",
		cliCommandUpdating: "Une mise à jour est en cours d'installation. Gérez la commande une fois l'installation terminée.",
		cliCommandNewTerminal: "Ouvrez un nouveau terminal et exécutez dsh --version.",
		cliCommandRemoved: "Enregistrement des commandes de bureau supprimé.",
		cliCommandPreviousRestored: "Le lanceur précédent a été restauré.",
		cliCommandOtherKept: "D'autres installations de commandement ont été laissées en place.",
		cliCommandBackupKept: "Un lanceur précédent est conservé à\xA0: {path}",
		cliCommandChanged: "La commande ou PATH a changé pendant que cette boîte de dialogue était ouverte. Ouvrez à nouveau la commande Gérer dsh pour vérifier l'état actuel.",
		cliCommandOwnershipError: "L'enregistrement ou la sauvegarde de la commande a été modifiée. Aucune commande sans rapport n'a été supprimée.",
		cliCommandFailed: "La commande n'a pas pu être mise à jour. Vérifiez que l'application est installée et que la destination est accessible en écriture, puis réessayez.",
		application: "Application",
		fileMenu: "Fichier",
		closePage: "Fermer la page ou la fenêtre",
		aboutMenu: "À propos de DeepSeek Harness",
		aboutProduct: "DeepSeek Harness",
		aboutVersion: "VersionV{version}",
		hideApplication: "Masquer DeepSeek Harness",
		hideOtherApplications: "Masquer les autres",
		showAllApplications: "Afficher tout",
		substitutionsMenu: "Substitutions",
		speechMenu: "Parole",
		quitApplication: "Quitter DeepSeek Harness",
		openApplication: "Ouvrir DeepSeek Harness",
		quit: "Quitter",
		cancel: "Annuler",
		quitTitle: "Quitter DeepSeek Harness\xA0?",
		quitActiveTasks: "Les tâches en cours seront interrompues.",
		quitScheduledTasks: "Les tâches planifiées ne s'exécuteront pas lorsque l'application est fermée.",
		quitActiveAndScheduledTasks: "Les tâches en cours d'exécution seront interrompues et les tâches planifiées ne s'exécuteront pas tant que l'application sera fermée.",
		backgroundNoticeBody: "Les tâches en cours continueront. Vous pouvez rouvrir la fenêtre à partir de la barre d'état système.",
		backgroundNoticeConfirm: "Confirmer",
		edit: "Modifier",
		menuBar: "Menu des applications",
		delete: "Supprimer",
		undo: "Annuler",
		redo: "Refaire",
		cut: "Couper",
		copy: "Copier",
		paste: "Coller",
		selectAll: "Sélectionner tout",
		startupFailed: "DeepSeek Harness n'est pas disponible",
		fatalSummary: "L'application n'a pas pu démarrer ou s'est arrêtée de manière inattendue.",
		startupAddressInUse: "Une autre instance DSH (telle que le Web dsh ou l'application de bureau) est en cours d'exécution. Ils ne peuvent pas démarrer en même temps. Quittez l'autre instance DSH en cours d'exécution, puis redémarrez.",
		diagnosticTruncated: "… Détails de l’erreur raccourcis.",
		reportWrittenTo: "Rapport de diagnostic\xA0: {path}",
		getDiagnosticReport: "Obtenir le rapport de diagnostic",
		reportPending: "Le rapport de diagnostic est en cours d’enregistrement. Sélectionnez Obtenir le rapport de diagnostic pour vérifier à nouveau.",
		reportUnavailable: "Le rapport de diagnostic n’a pas pu être enregistré. Vous pouvez fournir une capture d’écran de cette boîte de dialogue lorsque vous contactez l’assistance.",
		reportShareHint: "L’emplacement du rapport a été ouvert. Joignez le fichier sélectionné à votre demande d’assistance.",
		reportRevealFailed: "L’emplacement du rapport n’a pas pu être ouvert. Utilisez le chemin ci-dessous pour trouver le fichier.",
		startupReinstallAdvice: "Si les fichiers de l'application sont manquants ou endommagés, fermez l'application et réinstallez-la. Vos tâches sont stockées séparément.",
		exitApplication: "Quitter",
		restartApplication: "Redémarrer",
		recoveryOperationFailed: "L'opération de récupération a échoué",
		disableThirdPartyPlugins: "Désactivez les plugins tiers, sauvegardez le correctif de profil et redémarrez",
		welcomeTitle: "DeepSeek Harness",
		welcomeBrand: "DeepSeek Harness",
		welcomeTaglineBefore: "Bienvenue à ",
		welcomeTaglineBrand: "DeepSeek Harness",
		welcomeTaglineAfter: "",
		welcomeDescription: "Développer le potentiel. Explorez l'intelligence.",
		welcomeAuthStarting: "Ouverture de la connexion…",
		welcomeAuthWaiting: "Le navigateur ne s'est pas ouvert automatiquement ?",
		welcomeAuthWaitingDescription: "Copiez le lien de connexion et ouvrez-le dans votre navigateur pour vous connecter.",
		welcomeAuthExchanging: "Connexion terminée…",
		welcomeAuthExpired: "La connexion a expiré",
		welcomeAuthExpiredDescription: "Connectez-vous à nouveau pour continuer",
		welcomeAuthFailed: "Impossible de terminer la connexion. Veuillez réessayer.",
		welcomeAuthCopyLink: "Copier le lien de connexion",
		welcomeAuthCopied: "Copié",
		welcomeAuthCopyFailed: "Impossible de copier. Essayer à nouveau.",
		welcomeAuthCancel: "Annuler",
		welcomeAuthRetry: "Connectez-vous à nouveau",
		welcomeSignIn: "Connectez-vous",
		welcomeApiKey: "Ajouter une clé API",
		welcomeKeyTitle: "Ajoutez une clé API pour commencer",
		welcomeKeyDescription: "Configurez les modèles DeepSeek officiels pour commencer à utiliser Harness",
		welcomeKeyPlaceholder: "Entrez la clé API",
		welcomeKeySave: "Enregistrer et continuer",
		welcomeKeyLater: "Configurer plus tard",
		welcomeKeyBack: "Retour pour vous connecter",
		welcomeSessionExpired: "Vous vous êtes déconnecté de votre compte, veuillez vous reconnecter.",
		welcomeKeyBlank: "Entrez une clé API.",
		welcomeKeyInvalid: "Entrez la clé API elle-même, sans guillemets, espaces ni affectation de variable d'environnement.",
		welcomeKeyFailed: "Impossible d'enregistrer la clé API. Veuillez réessayer.",
		welcomeContinueFailed: "Impossible d'ouvrir l'espace de travail. Veuillez réessayer.",
		checkUpdatesMenu: "Vérifiez les mises à jour…",
		reloadPageMenu: "Recharger la page",
		toggleDevToolsMenu: "Outils de développement",
		restartAppHostMenu: "Redémarrez l'application et l'hôte",
		updateConfigurationFailed: "Impossible d’appliquer les paramètres de mise à jour. Corrigez le fichier et redémarrez, ou sélectionnez un canal dans les paramètres.",
		updateConfigurationRead: "Erreur du fichier de paramètres ; mises à jour suspendues",
		updateConfigurationFormat: "Erreur du fichier de paramètres ; mises à jour suspendues",
		updateConfigurationChannel: "Erreur du fichier de paramètres ; mises à jour suspendues",
		updateConfigurationCleanup: "Mises à jour suspendues : suppression de la mise à jour précédente impossible ; redémarrez l’application",
		updateReloadSettings: "Recharger les paramètres",
		updateConfigurationDetails: "Vérifier les paramètres",
		updateShowSettingsFile: "Afficher le fichier de paramètres",
		updateCheckFailedTitle: "Échec de la vérification de la mise à jour",
		updateCheckFailed: "Impossible de vérifier les mises à jour. Veuillez réessayer plus tard.",
		updateDownloadFailed: "Impossible de télécharger la mise à jour. Veuillez réessayer.",
		updateDownloadSpaceFailed: "Espace disque insuffisant pour télécharger la mise à jour. Libérez de l’espace, puis réessayez.",
		updateDownloadPermissionFailed: "Impossible d’écrire les fichiers de mise à jour. Vérifiez les autorisations du dossier, puis réessayez.",
		updateDownloadBusyFailed: "Un fichier de mise à jour est utilisé. Fermez le programme qui l’utilise, puis réessayez.",
		updateInstallFailed: "Impossible d'installer la mise à jour. Veuillez réessayer plus tard.",
		updateCheckNetworkFailed: "Impossible de vérifier les mises à jour. Vérifiez votre connexion et réessayez.",
		updateDownloadNetworkFailed: "Impossible de télécharger la mise à jour. Vérifiez votre connexion et réessayez.",
		updateInstallNetworkFailed: "Impossible d'installer la mise à jour. Vérifiez votre connexion et réessayez.",
		unknownError: "Erreur inconnue",
		updateCheckTitle: "Vérifier les mises à jour",
		updateCurrentDetail: "Version actuelle\xA0: {version}",
		updateCurrent: "Vous êtes à jour\xA0!",
		updateChecking: "Vérification des mises à jour…",
		updateDownload: "Télécharger la mise à jour",
		updateDownloadedTitle: "La version {version} est prête à installer",
		updateDownloadedDetail: "L'application se fermera pendant la mise à jour et rouvrira automatiquement une fois celle-ci terminée.",
		updateDownloadedDetailWindows: "L'application se fermera temporairement pendant la mise à jour et rouvrira automatiquement une fois celle-ci terminée.\n\nLa mise à jour peut prendre un certain temps. Veuillez patienter et ne pas relancer l'application pendant l'installation.",
		updateClose: "Fermer",
		updateAcknowledge: "OK",
		updateLater: "Mettre à jour plus tard",
		updateDownloadInProgress: "Téléchargement de la mise à jour",
		updateDownloadDetail: "La mise à jour se télécharge en arrière-plan. Vous pouvez continuer à utiliser l’application.",
		updateDownloading: "Téléchargement de {percent}%…",
		updateVerifying: "Vérification des fichiers de mise à jour…",
		updateInstalling: "Préparation du redémarrage…",
		updateRetry: "Réessayez la mise à jour",
		updateActiveTasks: "Les tâches sont toujours en cours",
		updateActiveTasksDetail: "La mise à jour arrêtera les tâches en cours et redémarrera l'application. Continuer?",
		updateStopTasks: "Arrêter les tâches et mettre à jour",
		updateTasksChanged: "De nouvelles tâches ont commencé. Confirmez à nouveau pour arrêter les tâches et mettre à jour.",
		updateTasksUnavailable: "L'état de la tâche n'est pas disponible. Essayez à nouveau de mettre à jour lorsque l'espace de travail est prêt.",
		updateFullscreenTimeout: "Impossible de quitter le mode plein écran. Quittez le mode plein écran, puis réessayez la mise à jour.",
		updateStopFailed: "Impossible d'arrêter les tâches en toute sécurité. La mise à jour n'a pas été installée. Veuillez réessayer plus tard.",
		updateTechnicalDetails: "Voir les détails techniques",
		updateTitle: "Mise à jour DeepSeek Harness",
		updateAvailable: "Nouvelle version disponible : {version}",
		updateDetail: "Une fois le téléchargement terminé, vous pouvez installer la mise à jour et redémarrer l'application.",
		installAndRestart: "Installer et redémarrer",
		later: "Plus tard",
		updateFailedTitle: "Échec de la mise à jour",
		mandatoryTitle: "Mettre à jour pour continuer",
		mandatoryDetail: "Cette version n'est plus prise en charge. Mettez à jour pour continuer. Les tâches en cours continueront à s'exécuter jusqu'à ce que vous confirmiez l'installation et redémarriez.",
		mandatoryUnavailable: "Impossible de vérifier les exigences de mise à jour. Veuillez réessayer plus tard.",
		policyLoginTitle: "Connectez-vous à l'environnement de test",
		policyLoginRequired: "Connectez-vous avec Feishu pour vérifier les exigences de mise à jour pour cette version de test. La connexion ne téléchargera ni n’installera de mise à jour.",
		policyLogin: "Connectez-vous avec Feishu",
		policyLoginFailed: "La connexion à Feishu n’a pas abouti. Veuillez réessayer.",
		policyLoginLoading: "Chargement de la page de connexion…",
		mandatoryNoRelease: "Aucune mise à jour compatible n'a été trouvée. Vérifiez à nouveau ou contactez l'assistance.",
		mandatoryRefresh: "Vérifiez à nouveau",
		mandatoryPage: "Télécharger depuis le site officiel",
		mandatoryCopy: "Copier le lien de téléchargement",
		mandatoryPageFailed: "Impossible d'ouvrir la page de téléchargement officielle. Copiez le lien et ouvrez-le dans votre navigateur.",
		mandatoryViewDownload: "Ouvrir la page de téléchargement",
		mandatoryViewPageFailed: "Impossible d'ouvrir la page de téléchargement. Veuillez réessayer.",
		mandatoryActionFailed: "L'action a échoué. Veuillez réessayer. Vous pourrez réutiliser l'application une fois la mise à jour terminée.",
		mandatoryReady: "Mise à jour prête",
		mandatoryVersion: "Nouvelle version\xA0: {version}",
		mandatoryReadyDetail: "L'application se fermera pendant la mise à jour et rouvrira automatiquement une fois celle-ci terminée.",
		mandatoryDeferred: "Les tâches en cours continueront à s'exécuter. Terminez la mise à jour avant d'utiliser à nouveau l'application.",
		mandatoryContinue: "Continuer la mise à jour",
		mandatoryInspecting: "Vérification des tâches…",
		mandatoryStopping: "Arrêt des tâches…",
		mandatoryRestarting: "L'application redémarrera sous peu. S'il vous plaît, attendez.",
		mandatoryDownloadFailed: "Les fichiers de mise à jour n'ont pas pu être téléchargés ou préparés. Veuillez réessayer.",
		mandatoryInstallFailed: "La mise à jour n'a pas été installée. Vérifiez à nouveau les tâches et réessayez.",
		mandatoryOpenHelp: "La page ne s'est pas ouverte ?",
		mandatoryReopen: "Ouvrez à nouveau la page de téléchargement officielle",
		mandatoryCopied: "Lien copié",
		mandatoryCopyFailed: "Impossible de copier le lien. Sélectionnez-le et copiez-le ci-dessous.",
		mandatoryAddress: "Lien de téléchargement",
		mandatoryNotification: "Revenez à l'application pour confirmer l'installation et redémarrer."
	},
	de: {
		cliCommandMenu: "dsh-Befehl verwalten…",
		cliCommandTitle: "dsh-Befehl verwalten",
		cliCommandLocation: "Desktop-Befehl: {path}",
		cliCommandSelected: "Aktueller dsh-Befehl: {path}",
		cliCommandTarget: "Aktuelles Launcher-Ziel: {path}",
		cliCommandShadowed: "Ein anderer dsh hat Vorrang. Entfernen Sie diese Installation oder ordnen Sie sie neu an, um standardmäßig den Desktop-Befehl zu verwenden. Sie können den Desktop-Befehl auch über seinen vollständigen Pfad ausführen.",
		cliCommandSelectionUnknown: "Ihr Shell-Befehl konnte nicht überprüft werden. Ein Alias oder eine andere dsh-Installation kann Vorrang haben.",
		cliCommandInstalled: "Der Desktop-Befehl ist installiert.",
		cliCommandNotInstalled: "Fügen Sie den Desktop-Befehl zu Ihrem Terminal hinzu.",
		cliCommandBroken: "Der Desktop-Befehl muss repariert werden.",
		cliCommandInstall: "Installieren",
		cliCommandRepair: "Reparieren",
		cliCommandRemove: "Entfernen",
		cliCommandClose: "Schließen",
		cliCommandSwitch: "Mit dem Desktop-Befehl fortfahren?",
		cliCommandPreserve: "Ein vorhandener Befehl bleibt erhalten. Andere Installationen und Shell-Startdateien werden nicht geändert.",
		cliCommandContinue: "Weiter",
		cliCommandInstallApp: "Installieren Sie Desktop in Ihrem Anwendungsordner, bevor Sie den Befehl dsh verwalten.",
		cliCommandUpdating: "Ein Update wird installiert. Verwalten Sie den Befehl nach Abschluss der Installation.",
		cliCommandNewTerminal: "Öffnen Sie ein neues Terminal und führen Sie dsh --version aus.",
		cliCommandRemoved: "Desktop-Befehlsregistrierung entfernt.",
		cliCommandPreviousRestored: "Der vorherige Launcher wurde wiederhergestellt.",
		cliCommandOtherKept: "Andere Befehlsinstallationen wurden beibehalten.",
		cliCommandBackupKept: "Ein früherer Launcher ist unter folgender Adresse erhalten: {path}",
		cliCommandChanged: "Der Befehl oder PATH hat sich geändert, während dieses Dialogfeld geöffnet war. Öffnen Sie den Befehl „dsh verwalten“ erneut, um den aktuellen Status zu überprüfen.",
		cliCommandOwnershipError: "Die Befehlsregistrierung oder Sicherung wurde geändert. Es wurde kein nicht verwandter Befehl entfernt.",
		cliCommandFailed: "Der Befehl konnte nicht aktualisiert werden. Überprüfen Sie, ob die Anwendung installiert ist und das Ziel beschreibbar ist, und versuchen Sie es dann erneut.",
		application: "Anwendung",
		fileMenu: "Datei",
		closePage: "Seite oder Fenster schließen",
		aboutMenu: "Über DeepSeek Harness",
		aboutProduct: "DeepSeek Harness",
		aboutVersion: "Version V{version}",
		hideApplication: "DeepSeek Harness ausblenden",
		hideOtherApplications: "Andere ausblenden",
		showAllApplications: "Alle einblenden",
		substitutionsMenu: "Ersetzungen",
		speechMenu: "Sprachausgabe",
		quitApplication: "DeepSeek Harness beenden",
		openApplication: "DeepSeek Harness öffnen",
		quit: "Beenden",
		cancel: "Abbrechen",
		quitTitle: "DeepSeek Harness beenden?",
		quitActiveTasks: "Laufende Aufgaben werden unterbrochen.",
		quitScheduledTasks: "Geplante Aufgaben werden nicht ausgeführt, während die App geschlossen ist.",
		quitActiveAndScheduledTasks: "Laufende Aufgaben werden unterbrochen und geplante Aufgaben werden nicht ausgeführt, während die App geschlossen ist.",
		backgroundNoticeBody: "Laufende Aufgaben werden fortgesetzt. Sie können das Fenster über die Taskleiste erneut öffnen.",
		backgroundNoticeConfirm: "Bestätigen",
		edit: "Bearbeiten",
		menuBar: "Anwendungsmenü",
		delete: "Löschen",
		undo: "Rückgängig machen",
		redo: "Wiederholen",
		cut: "Ausschneiden",
		copy: "Kopieren",
		paste: "Einfügen",
		selectAll: "Alles auswählen",
		startupFailed: "DeepSeek Harness ist nicht verfügbar",
		fatalSummary: "Die Anwendung konnte nicht gestartet werden oder wurde unerwartet gestoppt.",
		startupAddressInUse: "Eine andere DSH-Instanz (z. B. dsh Web oder die Desktop-App) wird ausgeführt. Sie können nicht gleichzeitig starten. Beenden Sie die andere laufende DSH-Instanz und starten Sie sie neu.",
		diagnosticTruncated: "… Fehlerdetails gekürzt.",
		reportWrittenTo: "Diagnosebericht: {path}",
		getDiagnosticReport: "Diagnosebericht abrufen",
		reportPending: "Der Diagnosebericht wird noch gespeichert. Wählen Sie „Diagnosebericht abrufen“, um ihn erneut zu prüfen.",
		reportUnavailable: "Der Diagnosebericht konnte nicht gespeichert werden. Sie können bei einer Supportanfrage einen Screenshot dieses Dialogs bereitstellen.",
		reportShareHint: "Der Speicherort des Berichts wurde geöffnet. Fügen Sie die ausgewählte Datei Ihrer Supportanfrage bei.",
		reportRevealFailed: "Der Speicherort des Berichts konnte nicht geöffnet werden. Verwenden Sie den folgenden Pfad, um die Datei zu finden.",
		startupReinstallAdvice: "Wenn Anwendungsdateien fehlen oder beschädigt sind, schließen Sie die Anwendung und installieren Sie sie erneut. Ihre Aufgaben werden separat gespeichert.",
		exitApplication: "Beenden",
		restartApplication: "Neustart",
		recoveryOperationFailed: "Der Wiederherstellungsvorgang ist fehlgeschlagen",
		disableThirdPartyPlugins: "Deaktivieren Sie Plugins von Drittanbietern, sichern Sie den Profil-Patch und starten Sie neu",
		welcomeTitle: "DeepSeek Harness",
		welcomeBrand: "DeepSeek Harness",
		welcomeTaglineBefore: "Willkommen bei ",
		welcomeTaglineBrand: "DeepSeek Harness",
		welcomeTaglineAfter: "",
		welcomeDescription: "Potenzial aufbauen. Entdecken Sie Intelligenz.",
		welcomeAuthStarting: "Anmeldung wird geöffnet…",
		welcomeAuthWaiting: "Browser wurde nicht automatisch geöffnet?",
		welcomeAuthWaitingDescription: "Kopieren Sie den Anmeldelink und öffnen Sie ihn in Ihrem Browser, um sich anzumelden.",
		welcomeAuthExchanging: "Anmeldung wird abgeschlossen…",
		welcomeAuthExpired: "Zeitüberschreitung bei der Anmeldung",
		welcomeAuthExpiredDescription: "Melden Sie sich erneut an, um fortzufahren",
		welcomeAuthFailed: "Die Anmeldung konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.",
		welcomeAuthCopyLink: "Anmeldelink kopieren",
		welcomeAuthCopied: "Kopiert",
		welcomeAuthCopyFailed: "Konnte nicht kopiert werden. Versuchen Sie es erneut.",
		welcomeAuthCancel: "Abbrechen",
		welcomeAuthRetry: "Erneut anmelden",
		welcomeSignIn: "Anmelden",
		welcomeApiKey: "API-Schlüssel hinzufügen",
		welcomeKeyTitle: "Fügen Sie einen API-Schlüssel hinzu, um loszulegen",
		welcomeKeyDescription: "Konfigurieren Sie offizielle DeepSeek-Modelle für die Verwendung von Harness",
		welcomeKeyPlaceholder: "API-Schlüssel eingeben",
		welcomeKeySave: "Speichern und fortfahren",
		welcomeKeyLater: "Später einrichten",
		welcomeKeyBack: "Zurück zur Anmeldung",
		welcomeSessionExpired: "Sie haben sich von Ihrem Konto abgemeldet. Bitte melden Sie sich erneut an.",
		welcomeKeyBlank: "Geben Sie einen API-Schlüssel ein.",
		welcomeKeyInvalid: "Geben Sie den API-Schlüssel selbst ein, ohne Anführungszeichen, Leerzeichen oder eine Umgebungsvariablenzuweisung.",
		welcomeKeyFailed: "Der API-Schlüssel konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.",
		welcomeContinueFailed: "Der Arbeitsbereich konnte nicht geöffnet werden. Bitte versuchen Sie es erneut.",
		checkUpdatesMenu: "Nach Updates suchen…",
		reloadPageMenu: "Seite neu laden",
		toggleDevToolsMenu: "Entwicklertools",
		restartAppHostMenu: "Anwendung und Host neu starten",
		updateConfigurationFailed: "Die Update-Einstellungen konnten nicht angewendet werden. Korrigiere die Datei und starte neu, oder wähle in den Einstellungen einen Update-Kanal.",
		updateConfigurationRead: "Fehler in der Einstellungsdatei; Updates pausiert",
		updateConfigurationFormat: "Fehler in der Einstellungsdatei; Updates pausiert",
		updateConfigurationChannel: "Fehler in der Einstellungsdatei; Updates pausiert",
		updateConfigurationCleanup: "Updates pausiert: vorheriges Update nicht verwerfbar; App neu starten",
		updateReloadSettings: "Einstellungen neu laden",
		updateConfigurationDetails: "Einstellungen prüfen",
		updateShowSettingsFile: "Einstellungsdatei anzeigen",
		updateCheckFailedTitle: "Update-Überprüfung fehlgeschlagen",
		updateCheckFailed: "Es konnte nicht nach Updates gesucht werden. Bitte versuchen Sie es später noch einmal.",
		updateDownloadFailed: "Das Update konnte nicht heruntergeladen werden. Bitte versuchen Sie es erneut.",
		updateDownloadSpaceFailed: "Nicht genügend Speicherplatz für das Update. Geben Sie Speicherplatz frei und versuchen Sie es erneut.",
		updateDownloadPermissionFailed: "Update-Dateien können nicht geschrieben werden. Prüfen Sie die Ordnerberechtigungen und versuchen Sie es erneut.",
		updateDownloadBusyFailed: "Eine Update-Datei wird verwendet. Schließen Sie das verwendende Programm und versuchen Sie es erneut.",
		updateInstallFailed: "Das Update konnte nicht installiert werden. Bitte versuchen Sie es später noch einmal.",
		updateCheckNetworkFailed: "Es konnte nicht nach Updates gesucht werden. Überprüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
		updateDownloadNetworkFailed: "Das Update konnte nicht heruntergeladen werden. Überprüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
		updateInstallNetworkFailed: "Das Update konnte nicht installiert werden. Überprüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
		unknownError: "Unbekannter Fehler",
		updateCheckTitle: "Nach Updates suchen",
		updateCurrentDetail: "Aktuelle Version: {version}",
		updateCurrent: "Sie verwenden die neueste Version.",
		updateChecking: "Suche nach Updates…",
		updateDownload: "Update herunterladen",
		updateDownloadedTitle: "Die Version {version} ist zur Installation bereit",
		updateDownloadedDetail: "Die App wird während des Updates geschlossen und nach Abschluss automatisch wieder geöffnet.",
		updateDownloadedDetailWindows: "Die App wird während des Updates vorübergehend geschlossen und nach Abschluss automatisch wieder geöffnet.\n\nDas Update kann einige Zeit dauern. Bitte warten Sie und starten Sie die App während der Installation nicht erneut.",
		updateClose: "Schließen",
		updateAcknowledge: "OK",
		updateLater: "Später aktualisieren",
		updateDownloadInProgress: "Update wird heruntergeladen",
		updateDownloadDetail: "Das Update wird im Hintergrund heruntergeladen. Sie können die App weiter verwenden.",
		updateDownloading: "{percent}% wird heruntergeladen…",
		updateVerifying: "Aktualisierungsdateien werden überprüft…",
		updateInstalling: "Neustart wird vorbereitet…",
		updateRetry: "Update erneut versuchen",
		updateActiveTasks: "Aufgaben sind noch in Bearbeitung",
		updateActiveTasksDetail: "Durch die Aktualisierung werden die laufenden Aufgaben gestoppt und die App neu gestartet. Weitermachen?",
		updateStopTasks: "Aufgaben beenden und Update installieren",
		updateTasksChanged: "Neue Aufgaben haben begonnen. Bestätigen Sie erneut, um die Aufgaben zu stoppen und zu aktualisieren.",
		updateTasksUnavailable: "Der Aufgabenstatus ist nicht verfügbar. Versuchen Sie erneut, die Aktualisierung durchzuführen, wenn der Arbeitsbereich bereit ist.",
		updateFullscreenTimeout: "Der Vollbildmodus konnte nicht beendet werden. Beenden Sie den Vollbildmodus und versuchen Sie dann erneut, das Update durchzuführen.",
		updateStopFailed: "Die Aufgaben konnten nicht sicher gestoppt werden. Das Update wurde nicht installiert. Bitte versuchen Sie es später noch einmal.",
		updateTechnicalDetails: "Technische Details anzeigen",
		updateTitle: "DeepSeek Harness-Update",
		updateAvailable: "Neue Version verfügbar: {version}",
		updateDetail: "Sobald der Download abgeschlossen ist, können Sie das Update installieren und die App neu starten.",
		installAndRestart: "Installieren und neu starten",
		later: "Später",
		updateFailedTitle: "Aktualisierung fehlgeschlagen",
		mandatoryTitle: "Aktualisieren, um fortzufahren",
		mandatoryDetail: "Diese Version wird nicht mehr unterstützt. Aktualisieren, um fortzufahren. Laufende Aufgaben werden so lange ausgeführt, bis Sie die Installation bestätigen und neu starten.",
		mandatoryUnavailable: "Update-Anforderungen konnten nicht überprüft werden. Bitte versuchen Sie es später noch einmal.",
		policyLoginTitle: "Melden Sie sich bei der Testumgebung an",
		policyLoginRequired: "Melden Sie sich bei Feishu an, um die Update-Anforderungen für diesen Test-Build zu prüfen. Durch die Anmeldung wird kein Update heruntergeladen oder installiert.",
		policyLogin: "Melden Sie sich mit Feishu an",
		policyLoginFailed: "Die Feishu-Anmeldung wurde nicht abgeschlossen. Bitte versuchen Sie es erneut.",
		policyLoginLoading: "Anmeldeseite wird geladen…",
		mandatoryNoRelease: "Es wurde kein kompatibles Update gefunden. Überprüfen Sie es erneut oder wenden Sie sich an den Support.",
		mandatoryRefresh: "Erneut prüfen",
		mandatoryPage: "Von der offiziellen Website herunterladen",
		mandatoryCopy: "Download-Link kopieren",
		mandatoryPageFailed: "Die offizielle Download-Seite konnte nicht geöffnet werden. Kopieren Sie den Link und öffnen Sie ihn in Ihrem Browser.",
		mandatoryViewDownload: "Download-Seite öffnen",
		mandatoryViewPageFailed: "Die Download-Seite konnte nicht geöffnet werden. Bitte versuchen Sie es erneut.",
		mandatoryActionFailed: "Die Aktion ist fehlgeschlagen. Bitte versuchen Sie es erneut. Nach Abschluss des Updates können Sie die App wieder verwenden.",
		mandatoryReady: "Update bereit",
		mandatoryVersion: "Neue Version: {version}",
		mandatoryReadyDetail: "Die App wird während des Updates geschlossen und nach Abschluss automatisch wieder geöffnet.",
		mandatoryDeferred: "Laufende Aufgaben werden weiterhin ausgeführt. Schließen Sie das Update ab, bevor Sie die App erneut verwenden.",
		mandatoryContinue: "Update fortsetzen",
		mandatoryInspecting: "Aufgaben prüfen…",
		mandatoryStopping: "Aufgaben stoppen…",
		mandatoryRestarting: "Die App wird in Kürze neu gestartet. Bitte warten.",
		mandatoryDownloadFailed: "Die Update-Dateien konnten nicht heruntergeladen oder vorbereitet werden. Bitte versuchen Sie es erneut.",
		mandatoryInstallFailed: "Das Update wurde nicht installiert. Überprüfen Sie die Aufgaben erneut und versuchen Sie es erneut.",
		mandatoryOpenHelp: "Seite wurde nicht geöffnet?",
		mandatoryReopen: "Offizielle Downloadseite erneut öffnen",
		mandatoryCopied: "Link kopiert",
		mandatoryCopyFailed: "Der Link konnte nicht kopiert werden. Wählen Sie es aus und kopieren Sie es unten.",
		mandatoryAddress: "Download-Link",
		mandatoryNotification: "Kehren Sie zur Anwendung zurück, um die Installation zu bestätigen und neu zu starten."
	},
	ru: {
		cliCommandMenu: "Управление командой dsh…",
		cliCommandTitle: "Управление командой dsh",
		cliCommandLocation: "Команда Desktop: {path}",
		cliCommandSelected: "Текущая команда dsh: {path}.",
		cliCommandTarget: "Текущая цель лаунчера: {path}",
		cliCommandShadowed: "Другой dsh имеет приоритет. Удалите или измените порядок установки, чтобы использовать команду «Desktop» по умолчанию. Вы также можете запустить команду «Desktop» по ее полному пути.",
		cliCommandSelectionUnknown: "Не удалось проверить вашу команду оболочки. Псевдоним или другая установка dsh может иметь приоритет.",
		cliCommandInstalled: "Команда «Desktop» установлена.",
		cliCommandNotInstalled: "Добавьте команду «Desktop» в свой терминал.",
		cliCommandBroken: "Команда Desktop требует ремонта.",
		cliCommandInstall: "Установить",
		cliCommandRepair: "Исправить",
		cliCommandRemove: "Удалить",
		cliCommandClose: "Закрыть",
		cliCommandSwitch: "Продолжить команду «Desktop»?",
		cliCommandPreserve: "Существующая команда будет сохранена. Другие установки и файлы запуска оболочки не будут изменены.",
		cliCommandContinue: "Продолжить",
		cliCommandInstallApp: "Установите Desktop в папку «Приложения», прежде чем управлять командой dsh.",
		cliCommandUpdating: "Идет установка обновления. Управляйте командой после завершения установки.",
		cliCommandNewTerminal: "Откройте новый терминал и запустите dsh --version.",
		cliCommandRemoved: "Регистрация команд Desktop удалена.",
		cliCommandPreviousRestored: "Предыдущий лаунчер восстановлен.",
		cliCommandOtherKept: "Остальные командные установки остались на месте.",
		cliCommandBackupKept: "Предыдущий лаунчер сохранился по адресу: {path}.",
		cliCommandChanged: "Команда или PATH изменилась, пока это диалоговое окно было открыто. Откройте команду «Управление dsh» еще раз, чтобы просмотреть текущее состояние.",
		cliCommandOwnershipError: "Регистрация команд или резервное копирование изменены. Ни одна несвязанная команда не была удалена.",
		cliCommandFailed: "Не удалось обновить команду. Убедитесь, что приложение установлено и место назначения доступно для записи, затем повторите попытку.",
		application: "Приложение",
		fileMenu: "Файл",
		closePage: "Закрыть страницу или окно",
		aboutMenu: "О DeepSeek Harness",
		aboutProduct: "DeepSeek Harness",
		aboutVersion: "Версия V{version}",
		hideApplication: "Скрыть DeepSeek Harness",
		hideOtherApplications: "Скрыть других",
		showAllApplications: "Показать все",
		substitutionsMenu: "Замены",
		speechMenu: "Речь",
		quitApplication: "Выйти из DeepSeek Harness",
		openApplication: "Открыть DeepSeek Harness",
		quit: "Выйти",
		cancel: "Отмена",
		quitTitle: "Выйти из DeepSeek Harness?",
		quitActiveTasks: "Выполнение задач будет прервано.",
		quitScheduledTasks: "Запланированные задачи не будут выполняться, пока приложение закрыто.",
		quitActiveAndScheduledTasks: "Выполнение задач будет прервано, а запланированные задачи не будут выполняться, пока приложение закрыто.",
		backgroundNoticeBody: "Выполнение задач продолжится. Вы можете снова открыть окно из системного трея.",
		backgroundNoticeConfirm: "Подтвердить",
		edit: "Редактировать",
		menuBar: "Меню приложения",
		delete: "Удалить",
		undo: "Отменить",
		redo: "Повторить",
		cut: "Вырезать",
		copy: "Копировать",
		paste: "Вставить",
		selectAll: "Выбрать все",
		startupFailed: "DeepSeek Harness недоступен.",
		fatalSummary: "Приложение не могло запуститься или неожиданно остановилось.",
		startupAddressInUse: "Другой экземпляр DSH (например, веб-приложение dsh или настольное приложение) запущен. Они не могут начаться одновременно. Закройте другой работающий экземпляр DSH, а затем перезапустите.",
		diagnosticTruncated: "… Подробности об ошибках сокращены.",
		reportWrittenTo: "Диагностический отчет: {path}",
		getDiagnosticReport: "Получить диагностический отчет",
		reportPending: "Диагностический отчет еще сохраняется. Выберите «Получить диагностический отчет», чтобы проверить еще раз.",
		reportUnavailable: "Не удалось сохранить диагностический отчет. При обращении в службу поддержки можно приложить снимок экрана этого диалогового окна.",
		reportShareHint: "Открыта папка с отчетом. Прикрепите выбранный файл к обращению в службу поддержки.",
		reportRevealFailed: "Не удалось открыть папку с отчетом. Найдите файл по указанному ниже пути.",
		startupReinstallAdvice: "Если файлы приложения отсутствуют или повреждены, закройте приложение и переустановите его. Ваши задачи хранятся отдельно.",
		exitApplication: "Выход",
		restartApplication: "Перезапустить",
		recoveryOperationFailed: "Операция восстановления не удалась",
		disableThirdPartyPlugins: "Отключите сторонние плагины, создайте резервную копию патча профиля и перезапустите.",
		welcomeTitle: "DeepSeek Harness",
		welcomeBrand: "DeepSeek Harness",
		welcomeTaglineBefore: "Добро пожаловать в ",
		welcomeTaglineBrand: "DeepSeek Harness",
		welcomeTaglineAfter: "",
		welcomeDescription: "Развивайте потенциал. Исследуйте интеллект.",
		welcomeAuthStarting: "Открытие входа в систему…",
		welcomeAuthWaiting: "Браузер не открылся автоматически?",
		welcomeAuthWaitingDescription: "Скопируйте ссылку для входа и откройте ее в браузере, чтобы войти.",
		welcomeAuthExchanging: "Завершение входа…",
		welcomeAuthExpired: "Время входа в систему истекло",
		welcomeAuthExpiredDescription: "Войдите еще раз, чтобы продолжить",
		welcomeAuthFailed: "Не удалось завершить вход. Повторите попытку.",
		welcomeAuthCopyLink: "Скопировать ссылку для входа",
		welcomeAuthCopied: "Скопировано",
		welcomeAuthCopyFailed: "Не удалось скопировать. Попробуйте еще раз.",
		welcomeAuthCancel: "Отмена",
		welcomeAuthRetry: "Войдите снова",
		welcomeSignIn: "Войти",
		welcomeApiKey: "Добавить ключ API",
		welcomeKeyTitle: "Добавьте ключ API, чтобы начать работу.",
		welcomeKeyDescription: "Настройте официальные модели DeepSeek, чтобы начать использовать Harness.",
		welcomeKeyPlaceholder: "Введите ключ API",
		welcomeKeySave: "Сохранить и продолжить",
		welcomeKeyLater: "Настроить позже",
		welcomeKeyBack: "Вернуться для входа в систему",
		welcomeSessionExpired: "Вы вышли из своей учетной записи, пожалуйста, войдите снова.",
		welcomeKeyBlank: "Введите ключ API.",
		welcomeKeyInvalid: "Введите сам ключ API без кавычек, пробелов и присвоения переменной среды.",
		welcomeKeyFailed: "Не удалось сохранить ключ API. Пожалуйста, попробуйте еще раз.",
		welcomeContinueFailed: "Не удалось открыть рабочую область. Пожалуйста, попробуйте еще раз.",
		checkUpdatesMenu: "Проверить наличие обновлений…",
		reloadPageMenu: "Обновить страницу",
		toggleDevToolsMenu: "Инструменты разработчика",
		restartAppHostMenu: "Перезапустите приложение и хост.",
		updateConfigurationFailed: "Не удалось применить настройки обновления. Исправьте файл и перезапустите приложение или выберите канал в настройках.",
		updateConfigurationRead: "Ошибка файла настроек; обновления приостановлены",
		updateConfigurationFormat: "Ошибка файла настроек; обновления приостановлены",
		updateConfigurationChannel: "Ошибка файла настроек; обновления приостановлены",
		updateConfigurationCleanup: "Обновления приостановлены: не удалось удалить предыдущее обновление; перезапустите приложение",
		updateReloadSettings: "Перечитать настройки",
		updateConfigurationDetails: "Проверить настройки",
		updateShowSettingsFile: "Показать файл настроек",
		updateCheckFailedTitle: "Проверка обновления не удалась",
		updateCheckFailed: "Не удалось проверить наличие обновлений. Пожалуйста, повторите попытку позже.",
		updateDownloadFailed: "Не удалось загрузить обновление. Пожалуйста, попробуйте еще раз.",
		updateDownloadSpaceFailed: "Недостаточно места для загрузки обновления. Освободите место и повторите попытку.",
		updateDownloadPermissionFailed: "Не удалось записать файлы обновления. Проверьте права доступа к папке и повторите попытку.",
		updateDownloadBusyFailed: "Файл обновления занят. Закройте использующую его программу и повторите попытку.",
		updateInstallFailed: "Не удалось установить обновление. Пожалуйста, повторите попытку позже.",
		updateCheckNetworkFailed: "Не удалось проверить наличие обновлений. Проверьте подключение и повторите попытку.",
		updateDownloadNetworkFailed: "Не удалось загрузить обновление. Проверьте подключение и повторите попытку.",
		updateInstallNetworkFailed: "Не удалось установить обновление. Проверьте подключение и повторите попытку.",
		unknownError: "Неизвестная ошибка",
		updateCheckTitle: "Проверьте наличие обновлений",
		updateCurrentDetail: "Текущая версия: {version}.",
		updateCurrent: "У вас последняя версия.",
		updateChecking: "Проверка обновлений…",
		updateDownload: "Скачать обновление",
		updateDownloadedTitle: "Версия {version} готова к установке.",
		updateDownloadedDetail: "Приложение закроется во время обновления и автоматически откроется после его завершения.",
		updateDownloadedDetailWindows: "Приложение временно закроется во время обновления и автоматически откроется после его завершения.\n\nОбновление может занять некоторое время. Пожалуйста, подождите и не запускайте приложение снова во время установки.",
		updateClose: "Закрыть",
		updateAcknowledge: "OK",
		updateLater: "Обновить позже",
		updateDownloadInProgress: "Загрузка обновления",
		updateDownloadDetail: "Обновление загружается в фоновом режиме. Вы можете продолжать пользоваться приложением.",
		updateDownloading: "Загрузка {percent}%…",
		updateVerifying: "Проверка файлов обновлений…",
		updateInstalling: "Подготовка к перезапуску…",
		updateRetry: "Повторить обновление",
		updateActiveTasks: "Задачи еще выполняются",
		updateActiveTasksDetail: "Обновление остановит выполняемые задачи и перезапустит приложение. Продолжать?",
		updateStopTasks: "Остановить задачи и обновить",
		updateTasksChanged: "Начались новые задачи. Подтвердите еще раз, чтобы остановить выполнение задач и выполнить обновление.",
		updateTasksUnavailable: "Статус задачи недоступен. Попробуйте обновить еще раз, когда рабочая область будет готова.",
		updateFullscreenTimeout: "Не удалось выйти из полноэкранного режима. Выйдите из полноэкранного режима и повторите попытку обновления.",
		updateStopFailed: "Не удалось безопасно остановить задачи. Обновление не установлено. Пожалуйста, повторите попытку позже.",
		updateTechnicalDetails: "Посмотреть технические подробности",
		updateTitle: "DeepSeek Harness Обновление",
		updateAvailable: "Доступна новая версия: {version}.",
		updateDetail: "После завершения загрузки вы можете установить обновление и перезапустить приложение.",
		installAndRestart: "Установить и перезапустить",
		later: "Позже",
		updateFailedTitle: "Обновление не выполнено",
		mandatoryTitle: "Обновите, чтобы продолжить",
		mandatoryDetail: "Эта версия больше не поддерживается. Обновите, чтобы продолжить. Выполняемые задачи будут продолжать выполняться до тех пор, пока вы не подтвердите установку и не перезапустите.",
		mandatoryUnavailable: "Не удалось проверить требования к обновлению. Пожалуйста, повторите попытку позже.",
		policyLoginTitle: "Войдите в тестовую среду",
		policyLoginRequired: "Войдите в систему с помощью Feishu, чтобы проверить требования к обновлению для этой тестовой сборки. При входе в систему обновление не загружается и не устанавливается.",
		policyLogin: "Войти через Feishu",
		policyLoginFailed: "Вход в Feishu не завершен. Пожалуйста, попробуйте еще раз.",
		policyLoginLoading: "Загрузка страницы входа…",
		mandatoryNoRelease: "Совместимое обновление не найдено. Проверьте еще раз или обратитесь в службу поддержки.",
		mandatoryRefresh: "Проверьте еще раз",
		mandatoryPage: "Скачать с официального сайта",
		mandatoryCopy: "Скопировать ссылку для скачивания",
		mandatoryPageFailed: "Не удалось открыть официальную страницу загрузки. Скопируйте ссылку и откройте ее в браузере.",
		mandatoryViewDownload: "Открыть страницу загрузки",
		mandatoryViewPageFailed: "Не удалось открыть страницу загрузки. Пожалуйста, попробуйте еще раз.",
		mandatoryActionFailed: "Не удалось выполнить действие. Повторите попытку. Вы сможете снова использовать приложение после завершения обновления.",
		mandatoryReady: "Обновление готово",
		mandatoryVersion: "Новая версия: {version}",
		mandatoryReadyDetail: "Приложение закроется во время обновления и автоматически откроется после его завершения.",
		mandatoryDeferred: "Выполняемые задачи будут продолжать выполняться. Завершите обновление, прежде чем снова использовать приложение.",
		mandatoryContinue: "Продолжить обновление",
		mandatoryInspecting: "Проверка задач…",
		mandatoryStopping: "Остановка задач…",
		mandatoryRestarting: "Приложение вскоре перезапустится. Пожалуйста, подождите.",
		mandatoryDownloadFailed: "Файлы обновления не удалось загрузить или подготовить. Пожалуйста, повторите попытку.",
		mandatoryInstallFailed: "Обновление не установлено. Проверьте задачи еще раз и повторите попытку.",
		mandatoryOpenHelp: "Страница не открылась?",
		mandatoryReopen: "Откройте официальную страницу загрузки еще раз.",
		mandatoryCopied: "Ссылка скопирована",
		mandatoryCopyFailed: "Не удалось скопировать ссылку. Выделите и скопируйте его ниже.",
		mandatoryAddress: "Ссылка для скачивания",
		mandatoryNotification: "Вернитесь в приложение, чтобы подтвердить установку и перезапустить."
	},
	pt: {
		cliCommandMenu: "Gerenciar comando dsh…",
		cliCommandTitle: "Gerenciar comando dsh",
		cliCommandLocation: "Comando da área de trabalho: {path}",
		cliCommandSelected: "Comando dsh atual: {path}",
		cliCommandTarget: "Alvo atual do iniciador: {path}",
		cliCommandShadowed: "Outro dsh tem precedência. Remova ou reordene essa instalação para usar o comando Desktop por padrão. Você também pode executar o comando Desktop pelo caminho completo.",
		cliCommandSelectionUnknown: "Seu comando shell não pôde ser verificado. Um alias ou outra instalação do dsh pode ter precedência.",
		cliCommandInstalled: "O comando Desktop está instalado.",
		cliCommandNotInstalled: "Adicione o comando Desktop ao seu terminal.",
		cliCommandBroken: "O comando Desktop precisa de reparo.",
		cliCommandInstall: "Instalar",
		cliCommandRepair: "Reparar",
		cliCommandRemove: "Remover",
		cliCommandClose: "Fechar",
		cliCommandSwitch: "Continuar com o comando Desktop?",
		cliCommandPreserve: "Um comando existente será preservado. Outras instalações e arquivos de inicialização do shell não serão alterados.",
		cliCommandContinue: "Continuar",
		cliCommandInstallApp: "Instale o Desktop na pasta Aplicativos antes de gerenciar o comando dsh.",
		cliCommandUpdating: "Uma atualização está sendo instalada. Gerencie o comando após a conclusão da instalação.",
		cliCommandNewTerminal: "Abra um novo terminal e execute dsh --version.",
		cliCommandRemoved: "Registro de comando da área de trabalho removido.",
		cliCommandPreviousRestored: "O inicializador anterior foi restaurado.",
		cliCommandOtherKept: "Outras instalações de comando foram mantidas.",
		cliCommandBackupKept: "Um inicializador anterior é preservado em: {path}",
		cliCommandChanged: "O comando ou PATH foi alterado enquanto esta caixa de diálogo estava aberta. Abra o comando Gerenciar dsh novamente para revisar o estado atual.",
		cliCommandOwnershipError: "O registro ou backup do comando foi alterado. Nenhum comando não relacionado foi removido.",
		cliCommandFailed: "O comando não pôde ser atualizado. Verifique se o aplicativo está instalado e se o destino é gravável e tente novamente.",
		application: "Aplicativo",
		fileMenu: "Arquivo",
		closePage: "Fechar página ou janela",
		aboutMenu: "Sobre DeepSeek Harness",
		aboutProduct: "DeepSeek Harness",
		aboutVersion: "Versão V{version}",
		hideApplication: "Ocultar DeepSeek Harness",
		hideOtherApplications: "Ocultar outros",
		showAllApplications: "Mostrar tudo",
		substitutionsMenu: "Substituições",
		speechMenu: "Fala",
		quitApplication: "Sair de DeepSeek Harness",
		openApplication: "Abra DeepSeek Harness",
		quit: "Sair",
		cancel: "Cancelar",
		quitTitle: "Sair de DeepSeek Harness?",
		quitActiveTasks: "As tarefas em execução serão interrompidas.",
		quitScheduledTasks: "As tarefas agendadas não serão executadas enquanto o aplicativo estiver fechado.",
		quitActiveAndScheduledTasks: "As tarefas em execução serão interrompidas e as tarefas agendadas não serão executadas enquanto o aplicativo estiver fechado.",
		backgroundNoticeBody: "As tarefas em execução continuarão. Você pode reabrir a janela na bandeja do sistema.",
		backgroundNoticeConfirm: "Confirmar",
		edit: "Editar",
		menuBar: "Menu de aplicativos",
		delete: "Excluir",
		undo: "Desfazer",
		redo: "Refazer",
		cut: "Cortar",
		copy: "Copiar",
		paste: "Colar",
		selectAll: "Selecionar tudo",
		startupFailed: "DeepSeek Harness não está disponível",
		fatalSummary: "O aplicativo não pôde ser iniciado ou parou inesperadamente.",
		startupAddressInUse: "Outra instância DSH (como dsh web ou aplicativo de desktop) está em execução. Eles não podem começar ao mesmo tempo. Saia da outra instância DSH em execução e reinicie.",
		diagnosticTruncated: "… Detalhes do erro reduzidos.",
		reportWrittenTo: "Relatório de diagnóstico: {path}",
		getDiagnosticReport: "Obter relatório de diagnóstico",
		reportPending: "O relatório de diagnóstico ainda está sendo salvo. Selecione Obter relatório de diagnóstico para verificar novamente.",
		reportUnavailable: "Não foi possível salvar o relatório de diagnóstico. Você pode fornecer uma captura de tela desta caixa de diálogo ao solicitar suporte.",
		reportShareHint: "O local do relatório foi aberto. Anexe o arquivo selecionado à sua solicitação de suporte.",
		reportRevealFailed: "Não foi possível abrir o local do relatório. Use o caminho abaixo para encontrar o arquivo.",
		startupReinstallAdvice: "Se os arquivos do aplicativo estiverem ausentes ou danificados, feche o aplicativo e reinstale-o. Suas tarefas são armazenadas separadamente.",
		exitApplication: "Sair",
		restartApplication: "Reiniciar",
		recoveryOperationFailed: "A operação de recuperação falhou",
		disableThirdPartyPlugins: "Desative plug-ins de terceiros, faça backup do patch do perfil e reinicie",
		welcomeTitle: "DeepSeek Harness",
		welcomeBrand: "DeepSeek Harness",
		welcomeTaglineBefore: "Bem-vindo ao ",
		welcomeTaglineBrand: "DeepSeek Harness",
		welcomeTaglineAfter: "",
		welcomeDescription: "Construir potencial. Explore a inteligência.",
		welcomeAuthStarting: "Abrindo login…",
		welcomeAuthWaiting: "O navegador não abriu automaticamente?",
		welcomeAuthWaitingDescription: "Copie o link de login e abra-o em seu navegador para fazer login.",
		welcomeAuthExchanging: "Concluindo login…",
		welcomeAuthExpired: "O tempo limite de login expirou",
		welcomeAuthExpiredDescription: "Faça login novamente para continuar",
		welcomeAuthFailed: "Não foi possível concluir o login. Tente novamente.",
		welcomeAuthCopyLink: "Copiar link de login",
		welcomeAuthCopied: "Copiado",
		welcomeAuthCopyFailed: "Não foi possível copiar. Tente novamente.",
		welcomeAuthCancel: "Cancelar",
		welcomeAuthRetry: "Faça login novamente",
		welcomeSignIn: "Faça login",
		welcomeApiKey: "Adicionar chave API",
		welcomeKeyTitle: "Adicione uma chave API para começar",
		welcomeKeyDescription: "Configure modelos DeepSeek oficiais para começar a usar o Harness",
		welcomeKeyPlaceholder: "Insira a chave de API",
		welcomeKeySave: "Salvar e continuar",
		welcomeKeyLater: "Configurar mais tarde",
		welcomeKeyBack: "Voltar para fazer login",
		welcomeSessionExpired: "Você saiu da sua conta, faça login novamente.",
		welcomeKeyBlank: "Insira uma chave API.",
		welcomeKeyInvalid: "Insira a própria chave API, sem aspas, espaços ou atribuição de variável de ambiente.",
		welcomeKeyFailed: "Não foi possível salvar a chave API. Por favor, tente novamente.",
		welcomeContinueFailed: "Não foi possível abrir o espaço de trabalho. Por favor, tente novamente.",
		checkUpdatesMenu: "Verifique se há atualizações…",
		reloadPageMenu: "Recarregar página",
		toggleDevToolsMenu: "Ferramentas do desenvolvedor",
		restartAppHostMenu: "Reinicie o aplicativo e o host",
		updateConfigurationFailed: "Não foi possível aplicar as configurações de atualização. Corrija o arquivo e reinicie, ou selecione um canal nas configurações.",
		updateConfigurationRead: "Erro no arquivo de configurações; atualizações pausadas",
		updateConfigurationFormat: "Erro no arquivo de configurações; atualizações pausadas",
		updateConfigurationChannel: "Erro no arquivo de configurações; atualizações pausadas",
		updateConfigurationCleanup: "Atualizações pausadas: não foi possível descartar a atualização anterior; reinicie o aplicativo",
		updateReloadSettings: "Recarregar configurações",
		updateConfigurationDetails: "Verificar configurações",
		updateShowSettingsFile: "Mostrar arquivo de configurações",
		updateCheckFailedTitle: "Falha na verificação de atualização",
		updateCheckFailed: "Não foi possível verificar se há atualizações. Por favor, tente novamente mais tarde.",
		updateDownloadFailed: "Não foi possível baixar a atualização. Por favor, tente novamente.",
		updateDownloadSpaceFailed: "Não há espaço suficiente para baixar a atualização. Libere espaço e tente novamente.",
		updateDownloadPermissionFailed: "Não foi possível gravar os arquivos de atualização. Verifique as permissões da pasta e tente novamente.",
		updateDownloadBusyFailed: "Um arquivo de atualização está em uso. Feche o programa que o utiliza e tente novamente.",
		updateInstallFailed: "Não foi possível instalar a atualização. Por favor, tente novamente mais tarde.",
		updateCheckNetworkFailed: "Não foi possível verificar se há atualizações. Verifique sua conexão e tente novamente.",
		updateDownloadNetworkFailed: "Não foi possível baixar a atualização. Verifique sua conexão e tente novamente.",
		updateInstallNetworkFailed: "Não foi possível instalar a atualização. Verifique sua conexão e tente novamente.",
		unknownError: "Erro desconhecido",
		updateCheckTitle: "Verifique se há atualizações",
		updateCurrentDetail: "Versão atual: {version}",
		updateCurrent: "Você está atualizado!",
		updateChecking: "Verificando atualizações…",
		updateDownload: "Baixar atualização",
		updateDownloadedTitle: "A versão {version} está pronta para instalação",
		updateDownloadedDetail: "O aplicativo será fechado durante a atualização e reaberto automaticamente quando for concluída.",
		updateDownloadedDetailWindows: "O aplicativo será fechado temporariamente durante a atualização e reaberto automaticamente quando for concluída.\n\nA atualização pode levar algum tempo. Aguarde e não inicie o aplicativo novamente durante a instalação.",
		updateClose: "Fechar",
		updateAcknowledge: "OK",
		updateLater: "Atualizar mais tarde",
		updateDownloadInProgress: "Baixando atualização",
		updateDownloadDetail: "A atualização está sendo baixada em segundo plano. Você pode continuar usando o aplicativo.",
		updateDownloading: "Baixando {percent}%…",
		updateVerifying: "Verificando arquivos de atualização…",
		updateInstalling: "Preparando para reiniciar…",
		updateRetry: "Tentar atualizar novamente",
		updateActiveTasks: "As tarefas ainda estão em andamento",
		updateActiveTasksDetail: "A atualização interromperá as tarefas em andamento e reiniciará o aplicativo. Continuar?",
		updateStopTasks: "Pare tarefas e atualize",
		updateTasksChanged: "Novas tarefas foram iniciadas. Confirme novamente para interromper as tarefas e atualizar.",
		updateTasksUnavailable: "O status da tarefa não está disponível. Tente atualizar novamente quando o espaço de trabalho estiver pronto.",
		updateFullscreenTimeout: "Não foi possível sair da tela cheia. Saia da tela inteira e tente atualizar novamente.",
		updateStopFailed: "Não foi possível interromper as tarefas com segurança. A atualização não foi instalada. Por favor, tente novamente mais tarde.",
		updateTechnicalDetails: "Ver detalhes técnicos",
		updateTitle: "DeepSeek Harness Atualização",
		updateAvailable: "Nova versão disponível: {version}",
		updateDetail: "Assim que o download for concluído, você pode instalar a atualização e reiniciar o aplicativo.",
		installAndRestart: "Instalar e reiniciar",
		later: "Mais tarde",
		updateFailedTitle: "Falha na atualização",
		mandatoryTitle: "Atualizar para continuar",
		mandatoryDetail: "Esta versão não é mais suportada. Atualize para continuar. As tarefas em andamento continuarão em execução até você confirmar a instalação e reiniciar.",
		mandatoryUnavailable: "Não foi possível verificar os requisitos de atualização. Por favor, tente novamente mais tarde.",
		policyLoginTitle: "Faça login no ambiente de teste",
		policyLoginRequired: "Faça login com Feishu para verificar os requisitos de atualização para esta versão de teste. O login não baixará nem instalará uma atualização.",
		policyLogin: "Faça login com Feishu",
		policyLoginFailed: "O login do Feishu não foi concluído. Por favor, tente novamente.",
		policyLoginLoading: "Carregando página de login…",
		mandatoryNoRelease: "Nenhuma atualização compatível foi encontrada. Verifique novamente ou entre em contato com o suporte.",
		mandatoryRefresh: "Verifique novamente",
		mandatoryPage: "Baixe do site oficial",
		mandatoryCopy: "Copiar link de download",
		mandatoryPageFailed: "Não foi possível abrir a página oficial de download. Copie o link e abra-o no seu navegador.",
		mandatoryViewDownload: "Abrir página de download",
		mandatoryViewPageFailed: "Não foi possível abrir a página de download. Por favor, tente novamente.",
		mandatoryActionFailed: "A ação falhou. Por favor, tente novamente. Você poderá usar o aplicativo novamente após a conclusão da atualização.",
		mandatoryReady: "Atualização pronta",
		mandatoryVersion: "Nova versão: {version}",
		mandatoryReadyDetail: "O aplicativo será fechado durante a atualização e reaberto automaticamente quando for concluída.",
		mandatoryDeferred: "As tarefas em andamento continuarão em execução. Conclua a atualização antes de usar o aplicativo novamente.",
		mandatoryContinue: "Continuar atualização",
		mandatoryInspecting: "Verificando tarefas…",
		mandatoryStopping: "Parando tarefas…",
		mandatoryRestarting: "O aplicativo será reiniciado em breve. Por favor, aguarde.",
		mandatoryDownloadFailed: "Os arquivos de atualização não puderam ser baixados ou preparados. Por favor, tente novamente.",
		mandatoryInstallFailed: "A atualização não foi instalada. Verifique as tarefas novamente e tente novamente.",
		mandatoryOpenHelp: "A página não abriu?",
		mandatoryReopen: "Abra a página oficial de download novamente",
		mandatoryCopied: "Link copiado",
		mandatoryCopyFailed: "Não foi possível copiar o link. Selecione e copie abaixo.",
		mandatoryAddress: "Link de download",
		mandatoryNotification: "Retorne ao aplicativo para confirmar a instalação e reinicie."
	}
};
/** Resolve Electron's locale to one shipped Desktop dictionary. */
function resolveDesktopLocale(locale) {
	const primary = locale.toLowerCase().split("-")[0];
	if (primary !== void 0 && Object.hasOwn(dictionaries, primary)) {
		const id = primary;
		return {
			id: id === "zh" ? "zh-CN" : id,
			messages: dictionaries[id]
		};
	}
	return {
		id: "en",
		messages: en
	};
}
/**
* Choose a built-in dictionary from the shared preference, then ordered OS languages.
* @param preference - explicit locale.preference, or null when no language was selected.
* @param languages - operating-system languages in preference order.
* @returns the supported dictionary, falling back to English.
*/
function resolveDesktopStartupLocale(preference, languages) {
	const selected = preference?.toLowerCase();
	if (selected !== void 0 && Object.hasOwn(dictionaries, selected)) return resolveDesktopLocale(selected);
	for (const language of languages) {
		const primary = language.toLowerCase().split("-")[0];
		if (primary !== void 0 && Object.hasOwn(dictionaries, primary)) return resolveDesktopLocale(primary);
	}
	return resolveDesktopLocale("en");
}
/** Replace named placeholders in one locale-owned message. */
function formatDesktopMessage(message, values) {
	return message.replaceAll(/\{([^{}]+)\}/gu, (placeholder, key) => values[key] ?? placeholder);
}
/**
* Select localized copy for an ordinary downloaded-update confirmation.
* @param messages - Selected Desktop dictionary.
* @param version - Prepared update version, including any prerelease suffix.
* @param platform - Operating system presenting the confirmation.
* @returns The versioned title and installation guidance.
*/
function desktopUpdateReadyConfirmation(messages, version, platform) {
	return {
		message: formatDesktopMessage(messages.updateDownloadedTitle, { version }),
		detail: platform === "win32" ? messages.updateDownloadedDetailWindows : messages.updateDownloadedDetail
	};
}
//#endregion
//#region lib/types/single-instance.js
/** Electron single-instance ownership before any Desktop profile lifecycle begins. */
/**
* Claim the process-lifetime Desktop lock and route later launches to the owner.
* @param application - Electron application singleton.
* @param focusOwner - focus or recreate the primary window after a later launch.
* @returns true only in the process that may access the Desktop profile.
*/
function claimDesktopSingleInstance(application, focusOwner) {
	if (!application.requestSingleInstanceLock()) {
		application.quit();
		return false;
	}
	application.on("second-instance", focusOwner);
	return true;
}
//#endregion
//#region lib/types/update-channel.js
/**
* Read the packaged channel; older manifests retain their existing nightly behavior.
* @param manifest Parsed application manifest.
* @returns Validated channel. Invalid explicit values reject instead of changing feeds.
*/
function desktopUpdateChannel(manifest) {
	if (typeof manifest !== "object" || manifest === null) throw new Error("desktop update: invalid application manifest");
	if (!("dshDesktopUpdateChannel" in manifest)) return "nightly";
	const channel = manifest.dshDesktopUpdateChannel;
	if (channel !== "nightly" && channel !== "stable") throw new Error("desktop update: invalid packaged channel");
	return channel;
}
//#endregion
//#region lib/types/updates/electron-updater/http-executor.js
/** Electron-native inactivity deadlines for updater checks, full downloads, and blockmap requests. */
/** Retains electron-updater transport and proxy handling while bounding silent connections. */
var DesktopUpdateHttpExecutor = class extends ElectronHttpExecutor {
	idleTimeoutMs;
	/**
	* @param idleTimeoutMs - Maximum silence before headers or between response chunks, not a total download deadline.
	* @param proxyLogin - Existing updater login event forwarding.
	*/
	constructor(idleTimeoutMs, proxyLogin) {
		super(proxyLogin);
		this.idleTimeoutMs = idleTimeoutMs;
		if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1e3 || idleTimeoutMs > 2147483647) throw new Error("desktop update: HTTP idle timeout must be an integer from 1000 through 2147483647");
	}
	addErrorAndTimeoutHandlers(request, reject) {
		super.addErrorAndTimeoutHandlers(request, reject, this.idleTimeoutMs);
		let response;
		let timer;
		const stop = () => {
			clearTimeout(timer);
			request.off("response", onResponse);
			request.off("abort", stop);
			request.off("error", stop);
			response?.off("data", refresh);
			response?.off("end", stop);
			response?.off("error", stop);
		};
		const refresh = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				stop();
				reject(Object.assign(/* @__PURE__ */ new Error("Desktop update connection timed out"), { code: "ETIMEDOUT" }));
				request.abort();
			}, this.idleTimeoutMs);
		};
		const onResponse = (incoming) => {
			response = incoming;
			response.on("data", refresh);
			response.once("end", stop);
			response.once("error", stop);
			refresh();
		};
		request.once("response", onResponse);
		request.once("abort", stop);
		request.once("error", stop);
		refresh();
	}
};
//#endregion
//#region lib/types/update-error.js
/** Only explicitly safe main-process facts may be exposed as technical details. */
var DesktopUpdatePreparationError = class extends Error {
	kind;
	technicalDetails;
	/**
	* @param kind - Stable preparation cause shared by native and Web presentations.
	* @param message - Locale-owned recovery guidance.
	* @param technicalDetails - Main-owned facts, excluding raw subprocess output and credentials.
	*/
	constructor(kind, message, technicalDetails) {
		super(message);
		this.kind = kind;
		this.technicalDetails = technicalDetails;
	}
};
/**
* Preserve current download diagnostics; never infer a cause from an older cleanup failure.
* @param error - Rejected updater download or filesystem error.
* @returns Structured filesystem cause when supplied by the failing operation.
*/
function downloadFailureDetails(error) {
	if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return {};
	const code = error.code;
	const kind = code === "ENOSPC" ? "space" : [
		"EACCES",
		"EPERM",
		"EROFS"
	].includes(code) ? "permission" : code === "EBUSY" ? "busy" : void 0;
	const path = "path" in error && typeof error.path === "string" ? error.path : void 0;
	const destination = "dest" in error && typeof error.dest === "string" ? error.dest : void 0;
	return {
		...kind === void 0 ? {} : { downloadFailure: kind },
		technicalDetails: [
			code,
			error.message,
			path,
			destination
		].filter((value) => value !== void 0).join("\n")
	};
}
//#endregion
//#region lib/types/updates/electron-updater/channel.js
/**
* Select the operator-managed feed, accepting prereleases while preventing downgrades.
* @param updater - Updater whose prior operations have settled.
* @param channel - Selected distribution channel.
*/
function selectUpdateChannel(updater, channel) {
	updater.channel = channel;
	updater.allowDowngrade = false;
	updater.allowPrerelease = true;
}
//#endregion
//#region lib/types/update-cleanup-log.js
/** Durable, best-effort diagnostics for obsolete update files that could not be removed. */
/**
* Flush one cleanup warning to disk; diagnostic failure falls back to stderr without reviving a target.
* @param directory - Shell-owned log directory, outside the update cache.
* @param failure - Failed cleanup operation; no update URL or settings contents.
*/
function recordUpdateCleanupFailure(directory, failure) {
	const error = failure.error;
	const entry = {
		time: (/* @__PURE__ */ new Date()).toISOString(),
		event: "update-cache-cleanup-failed",
		operation: failure.operation,
		path: failure.path,
		code: error instanceof Error && "code" in error ? String(error.code) : null,
		reason: error instanceof Error ? error.message : String(error)
	};
	try {
		mkdirSync(directory, { recursive: true });
		appendFileSync(join(directory, "update-cleanup.jsonl"), `${JSON.stringify(entry)}\n`, {
			mode: 384,
			flush: true
		});
	} catch (logError) {
		console.error("desktop update: could not persist cleanup warning", entry, logError);
	}
}
//#endregion
//#region lib/types/updates/electron-updater/discard.js
/**
* Revoke the library's pending target and await macOS's local feed server closure.
* This adapter depends on private electron-updater 6.x fields, covered by real-library tests.
* autoInstallOnAppQuit must be false and quitAndInstall must not have been called.
* @param updater - Settled updater owned by the Desktop coordinator.
* @returns After old in-memory targets and the local feed server are retired; residual files only produce durable warnings.
*/
async function discardDesktopUpdate(updater) {
	const internal = updater;
	if (internal.squirrelDownloadedUpdate === true) throw new Error("desktop update: native installation already staged");
	const server = internal.server;
	if (server?.listening) await new Promise((resolve, reject) => {
		server.close((error) => {
			if (error === void 0) resolve();
			else reject(error);
		});
	});
	internal.server = null;
	internal.updateInfoAndProvider = null;
	const helper = internal.downloadedUpdateHelper;
	if (helper == null) return;
	helper._file = null;
	helper._packageFile = null;
	helper.versionInfo = null;
	helper.fileInfo = null;
	helper._downloadedFileInfo = null;
	const directory = helper.cacheDirForPendingUpdate;
	let names;
	try {
		names = await readdir(directory);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) recordUpdateCleanupFailure(app.getPath("logs"), {
			operation: "list",
			path: directory,
			error
		});
		return;
	}
	for (const name of names) {
		const path = join(directory, name);
		try {
			await rm(path, {
				recursive: true,
				force: true
			});
		} catch (error) {
			recordUpdateCleanupFailure(app.getPath("logs"), {
				operation: "remove",
				path,
				error
			});
		}
	}
}
//#endregion
//#region lib/types/update-coordinator.js
/** User-authorized downloads and separate installation of one version-bound Desktop release. */
const { autoUpdater } = electronUpdater;
/** Owns one updater target until its download and installation settle. */
var DesktopUpdateCoordinator = class {
	publish;
	beforeRestart;
	updater;
	enabled;
	currentVersion;
	downloadResult;
	channel;
	discard;
	current = { phase: "idle" };
	release = { kind: "none" };
	disposed = false;
	generation = 0;
	switching = 0;
	downloadGeneration = 0;
	switchTail = Promise.resolve();
	cancellation;
	configurationError;
	checkOperation;
	downloadOperation;
	installOperation;
	onProgress = (progress) => {
		if (this.downloadGeneration !== this.generation || this.downloadOperation === void 0 || this.downloaded) return;
		const percent = Math.min(100, Math.max(0, progress.percent));
		this.setState({
			phase: percent >= 100 ? "verifying" : "downloading",
			...this.target(),
			percent
		});
	};
	onDownloaded = (info) => {
		if (this.downloadGeneration !== this.generation || this.downloadOperation === void 0 || info.version !== this.candidate) return;
		this.release = {
			kind: "downloaded",
			version: info.version
		};
	};
	onError = (error) => {
		if (this.current.phase === "installing") this.setState(this.failure(error, "install"));
	};
	/**
	* @param publish - Receives observable states for every Desktop window.
	* @param beforeRestart - Completes task authorization, admission locking, and owned-process shutdown.
	* @param updater - Process-owned Electron updater, replaceable at the network/platform test boundary.
	* @param enabled - Whether this process has a packaged update source.
	* @param currentVersion - Actual installed application version.
	* @param channel - Installed package channel; omitted test/local callers retain nightly.
	* @param discard - Clears settled library targets and platform resources before another channel is used.
	* @param downloadResult - Once per completed download attempt, including platform preparation failures.
	*/
	constructor(publish, beforeRestart, updater = autoUpdater, enabled = () => app.isPackaged && existsSync(join(process.resourcesPath, "app-update.yml")), currentVersion = () => app.getVersion(), downloadResult, channel = "nightly", discard = discardDesktopUpdate) {
		this.publish = publish;
		this.beforeRestart = beforeRestart;
		this.updater = updater;
		this.enabled = enabled;
		this.currentVersion = currentVersion;
		this.downloadResult = downloadResult;
		this.channel = channel;
		this.discard = discard;
		if (updater === autoUpdater) {
			const transportOwner = updater;
			transportOwner.httpExecutor = new DesktopUpdateHttpExecutor(Number(process.env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS ?? 6e4), (authInfo, callback) => {
				updater.emit("login", authInfo, callback);
			});
		}
		this.updater.autoDownload = false;
		this.updater.autoInstallOnAppQuit = false;
		selectUpdateChannel(this.updater, channel);
		this.updater.on("download-progress", this.onProgress);
		this.updater.on("update-downloaded", this.onDownloaded);
		this.updater.on("error", this.onError);
	}
	/** Latest observable state; complete download identity remains main-process-owned. */
	get state() {
		return this.current;
	}
	/** Reason ordinary updates are suspended, independently of the last operation result. */
	get configurationFailure() {
		return this.configurationError;
	}
	/** Selected runtime channel, including while a new feed is being checked. */
	get selectedChannel() {
		return this.channel;
	}
	/** Revision captured by confirmations so channel changes invalidate old user actions. */
	get revision() {
		return this.generation;
	}
	/**
	* Suspend ordinary updates when settings or previous-target cleanup are invalid.
	* @param detail - File path and safe diagnostic, without document contents.
	* @param reason - Startup validation or retirement of a previous target.
	*/
	suspendConfiguration(detail, reason = "startup") {
		this.configurationError = reason;
		this.setState({
			phase: "error",
			failedOperation: "configuration",
			message: detail
		});
	}
	/**
	* Persist a UI choice, retire the old target, and check the selected feed.
	* Accepted choices serialize; installation cannot start while any choice is pending.
	* Persistence failure leaves the previous channel and target intact. Cleanup failure
	* suspends updates until another explicit switch successfully retires the target.
	* @param channel - Validated UI choice.
	* @param persist - Atomic settings save; rejects before a choice is applied on failure.
	* @returns Whether the selection changed; healthy repeated choices preserve the current operation.
	*/
	switchChannel(channel, persist) {
		this.assertLive();
		if (this.installOperation !== void 0 || this.current.phase === "installing" || this.release.kind === "handed-off") return Promise.reject(/* @__PURE__ */ new Error("desktop update: installation is in progress"));
		this.switching++;
		const operation = this.switchTail.then(async () => {
			this.assertLive();
			if (channel === this.channel && this.configurationError === void 0) return "unchanged";
			await persist();
			this.generation++;
			this.cancellation?.cancel();
			await Promise.allSettled([this.checkOperation, this.downloadOperation]);
			this.assertLive();
			this.release = { kind: "none" };
			this.cancellation = void 0;
			try {
				await this.discard(this.updater);
			} catch (error) {
				this.suspendConfiguration("desktop update: could not retire the previous update", "cleanup");
				throw error;
			}
			this.channel = channel;
			selectUpdateChannel(this.updater, channel);
			this.configurationError = void 0;
			this.setState({ phase: "checking" });
			const result = await this.doCheck();
			if (result.phase === "error") this.setState(result);
			return "applied";
		}).finally(() => {
			this.switching--;
		});
		this.switchTail = operation.then(() => {}).catch(() => {});
		return operation;
	}
	/**
	* Check metadata without downloading, joining any current check.
	* @param manual - Whether a failed check must remain visible in the status indicator.
	* @returns The check result, including a silent automatic failure when applicable.
	*/
	async check(manual = false) {
		this.assertLive();
		if (this.configurationError !== void 0 || this.switching > 0 || this.downloadOperation !== void 0 || this.installOperation !== void 0 || this.downloaded) return this.current;
		if (!manual && this.current.phase === "error" && this.current.failedOperation === "download") return this.current;
		this.checkOperation ??= Promise.resolve().then(() => this.doCheck()).finally(() => {
			this.checkOperation = void 0;
		});
		const result = await this.checkOperation;
		if (manual && result.phase === "error") this.setState(result);
		return result;
	}
	/**
	* @param version - Version shown in the user's download confirmation.
	* @param revision - Revision captured by the download confirmation; omitted uses the current target.
	* @returns Download readiness or failure, without authorizing installation.
	*/
	async download(version, revision = this.generation) {
		this.assertLive();
		if (revision !== this.generation || this.configurationError !== void 0 || this.switching > 0) return this.current;
		if (this.downloaded || this.installOperation !== void 0) return this.current;
		const generation = this.generation;
		this.downloadGeneration = generation;
		this.downloadOperation ??= Promise.resolve().then(async () => {
			await this.checkOperation;
			if (generation !== this.generation) return this.current;
			this.assertLive();
			if (this.candidate === void 0) throw new Error("desktop update: no checked update is available");
			if (version !== this.candidate) throw new Error("desktop update: download confirmation is stale");
			this.setState({
				phase: "downloading",
				version,
				percent: 0
			});
			try {
				await this.updater.downloadUpdate(this.cancellation);
				if (generation !== this.generation || this.disposed) return this.current;
				if (!this.downloaded) throw new Error("desktop update: platform preparation did not report readiness");
				this.downloadResult?.(true);
				return this.setState({
					phase: "ready",
					version
				});
			} catch (error) {
				if (generation !== this.generation || this.disposed) return this.current;
				this.release = {
					kind: "checked",
					version
				};
				this.downloadResult?.(false, error instanceof DesktopUpdatePreparationError ? error.kind : "download_failed");
				return this.setState(this.failure(error, "download"));
			}
		}).finally(() => {
			this.downloadOperation = void 0;
		});
		return this.downloadOperation;
	}
	/**
	* Install a prepared target after a separate user confirmation.
	* @param version - Exact version displayed in the confirmation, never a renderer-selected URL.
	* @param revision - Revision captured when the confirmation began; omitted uses the current target.
	* @returns Installation handoff or a recoverable preparation error.
	*/
	async install(version, revision = this.generation) {
		this.assertLive();
		if (revision !== this.generation) return this.current;
		if (this.configurationError !== void 0 || this.switching > 0) throw new Error("desktop update: channel selection is not ready");
		if (!this.downloaded || this.downloadOperation !== void 0 || version !== this.candidate) throw new Error("desktop update: confirmed target is not ready");
		this.installOperation ??= Promise.resolve().then(async () => {
			this.setState({
				phase: "installing",
				version
			});
			try {
				if (!await this.beforeRestart()) return this.setState({
					phase: "ready",
					version
				});
				this.assertLive();
				this.release = {
					kind: "handed-off",
					version
				};
				this.updater.quitAndInstall(true, true);
				return this.current;
			} catch (error) {
				if (this.current.phase === "error" && this.current.failedOperation === "install") return this.current;
				return this.setState(this.failure(error, "install"));
			}
		}).finally(() => {
			this.installOperation = void 0;
		});
		return this.installOperation;
	}
	/** Remove owned listeners and prevent pending library operations from publishing into closed UI. */
	dispose() {
		this.disposed = true;
		this.updater.off("download-progress", this.onProgress);
		this.updater.off("update-downloaded", this.onDownloaded);
		Promise.allSettled([
			this.checkOperation,
			this.downloadOperation,
			this.installOperation,
			this.switchTail
		]).then(() => {
			this.updater.off("error", this.onError);
		});
	}
	get candidate() {
		return this.release.kind === "none" ? void 0 : this.release.version;
	}
	get downloaded() {
		return this.release.kind === "downloaded" || this.release.kind === "handed-off";
	}
	assertLive() {
		if (this.disposed) throw new Error("desktop update: coordinator is disposed");
	}
	setState(state) {
		if (!this.disposed) {
			this.current = state;
			this.publish(state);
		}
		return state;
	}
	failure(error, failedOperation) {
		return {
			phase: "error",
			...this.target(),
			failedOperation,
			message: error instanceof Error ? error.message : String(error),
			...failedOperation === "download" ? downloadFailureDetails(error) : {},
			...error instanceof DesktopUpdatePreparationError ? {
				preparationFailure: error.kind,
				...error.technicalDetails === void 0 ? {} : { technicalDetails: error.technicalDetails }
			} : {}
		};
	}
	target() {
		return this.candidate === void 0 ? {} : { version: this.candidate };
	}
	async doCheck() {
		const generation = this.generation;
		try {
			this.assertLive();
			if (!this.enabled()) throw new Error("desktop update: this application has no packaged update source");
			const result = await this.updater.checkForUpdates();
			if (generation !== this.generation || this.disposed) return this.current;
			if (result === null) throw new Error("desktop update: no check result was returned");
			this.cancellation = result.cancellationToken;
			const version = result.updateInfo.version;
			if (valid(version) === null) throw new Error("desktop update: feed version is invalid");
			this.release = result.isUpdateAvailable && gt(version, this.currentVersion()) ? {
				kind: "checked",
				version
			} : { kind: "none" };
			return this.setState(this.candidate === void 0 ? { phase: "idle" } : {
				phase: "available",
				version
			});
		} catch (error) {
			if (generation !== this.generation || this.disposed) return this.current;
			return this.failure(error, "check");
		}
	}
};
//#endregion
//#region lib/types/update-window.js
const FULLSCREEN_EXIT_TIMEOUT_MS = 5e3;
/**
* Leave macOS fullscreen before displaying installation confirmation.
* @param window - Product window that owns the update confirmation.
* @param timeoutMessage - Locale-owned guidance to exit fullscreen and retry.
* @returns Whether the window survived the completed native transition; destruction cancels installation.
* @throws {DesktopUpdatePreparationError} If macOS does not report completion within five seconds.
*/
async function prepareDesktopUpdateWindow(window, timeoutMessage) {
	if (window.isDestroyed()) return false;
	if (process.platform !== "darwin" || !window.isFullScreen()) return true;
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(deadline);
			window.off("leave-full-screen", left);
			window.off("closed", closed);
		};
		const left = () => {
			cleanup();
			resolve(true);
		};
		const closed = () => {
			cleanup();
			resolve(false);
		};
		const deadline = setTimeout(() => {
			cleanup();
			reject(new DesktopUpdatePreparationError("fullscreen-timeout", timeoutMessage));
		}, FULLSCREEN_EXIT_TIMEOUT_MS);
		window.once("leave-full-screen", left);
		window.once("closed", closed);
		try {
			window.setFullScreen(false);
		} catch (error) {
			cleanup();
			throw error;
		}
	});
}
//#endregion
//#region lib/types/command-management.js
/** Native command-management dialogs; only fixed installation locations reach the worker. */
var CommandWorkerError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
function object(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseState(value, platform) {
	if (!object(value) || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.fingerprint) || typeof value.managed !== "boolean" || typeof value.available !== "boolean") throw new Error("Invalid command-manager response.");
	const destination = platform === "win32" && typeof value.directory === "string" ? join(value.directory, "dsh.cmd") : value.destination;
	const launcher = platform === "win32" ? destination : value.launcher;
	if (typeof destination !== "string" || !isAbsolute(destination) || typeof launcher !== "string" || !isAbsolute(launcher)) throw new Error("Invalid command-manager locations.");
	for (const name of [
		"target",
		"activeCommand",
		"backup",
		"preservedBackup"
	]) if (value[name] !== void 0 && value[name] !== null && typeof value[name] !== "string") throw new Error("Invalid command-manager detail.");
	return {
		fingerprint: value.fingerprint,
		managed: value.managed,
		available: value.available,
		destination,
		launcher,
		occupied: platform === "win32" ? typeof value.activeCommand === "string" : value.kind !== "missing",
		...typeof value.target === "string" ? { target: value.target } : {},
		...typeof value.activeCommand === "string" ? { activeCommand: value.activeCommand } : {},
		...typeof value.backup === "string" ? { backup: value.backup } : {},
		...typeof value.preservedBackup === "string" ? { preservedBackup: value.preservedBackup } : {}
	};
}
function format(text, path) {
	return text.replace("{path}", path);
}
function sameCommand(left, right, platform) {
	return platform === "win32" ? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase() : normalize(left) === normalize(right);
}
/**
* Describe installation state using Desktop-owned copy.
* @param state - Observed link or PATH selection.
* @param messages - Current Desktop locale.
* @param platform - Command lookup semantics of the host operating system.
* @returns Native dialog with stable Close/Repair/Remove or Install/Cancel indices.
*/
function presentCommandManagement(state, messages, platform) {
	const other = state.activeCommand !== void 0 && !sameCommand(state.activeCommand, state.destination, platform);
	const detail = [
		format(messages.cliCommandLocation, state.destination),
		...state.activeCommand === void 0 ? [] : [format(messages.cliCommandSelected, state.activeCommand)],
		...state.target === void 0 ? [] : [format(messages.cliCommandTarget, state.target)],
		...other ? [messages.cliCommandShadowed] : [],
		...state.selectionUnknown ? [messages.cliCommandSelectionUnknown] : []
	].join("\n\n");
	return {
		type: other ? "warning" : "info",
		title: messages.cliCommandTitle,
		message: state.managed ? state.available ? messages.cliCommandInstalled : messages.cliCommandBroken : messages.cliCommandNotInstalled,
		detail,
		buttons: state.managed ? [
			messages.cliCommandClose,
			messages.cliCommandRepair,
			messages.cliCommandRemove
		] : [messages.cliCommandInstall, messages.cancel],
		defaultId: 0,
		cancelId: state.managed ? 0 : 1
	};
}
async function shellCommand() {
	const shell = userInfo().shell;
	if (shell === null) return { selectionUnknown: true };
	const { stdout } = await promisify(execFile)(shell, ["-ilc", "printf '\\0DSH_COMMAND\\0'; command -v dsh; printf '\\0'"], {
		timeout: 5e3,
		maxBuffer: 65536
	});
	const value = stdout.split("\0DSH_COMMAND\0")[1]?.split("\0")[0]?.trim();
	if (value === void 0) return { selectionUnknown: true };
	if (value === "") return {};
	return isAbsolute(value) && !/[\r\n]/u.test(value) ? { activeCommand: value } : { selectionUnknown: true };
}
/** One visible operation; updater preparation waits for its started worker to finish. */
var DesktopCommandManager = class {
	options;
	operation;
	/** @param options - Installed resources and shell-owned UI callbacks. */
	constructor(options) {
		this.options = options;
	}
	/** Open or join the command-management operation. */
	show() {
		return this.operation ??= this.run().finally(() => {
			this.operation = void 0;
		});
	}
	/** Wait for a command operation already started by the user. */
	async idle() {
		await this.operation;
	}
	async worker(operation, expected, elevated = false) {
		const node = join(this.options.resources, "runtime", "primary-runtime", "dependencies", "node", "bin", process.platform === "win32" ? "node.exe" : "node");
		const entry = join(this.options.resources, "runtime", "cli", "command-manager.js");
		let stdout;
		try {
			if (elevated) stdout = (await promisify(execFile)("/usr/bin/osascript", [
				"-e",
				"on run argv\nset cmd to \"/usr/bin/env -i \" & quoted form of (item 1 of argv) & \" \" & quoted form of (item 2 of argv) & \" \" & quoted form of (item 3 of argv) & \" \" & quoted form of (item 4 of argv)\ndo shell script cmd with administrator privileges\nend run",
				node,
				entry,
				operation,
				expected ?? ""
			], { maxBuffer: 65536 })).stdout;
			else {
				const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$/iu.test(name)));
				stdout = (await promisify(execFile)(node, [
					entry,
					operation,
					...expected === void 0 ? [] : [expected]
				], {
					timeout: 3e4,
					maxBuffer: 65536,
					windowsHide: true,
					env
				})).stdout;
			}
		} catch (error) {
			if (elevated && object(error) && typeof error.stderr === "string" && /\(-128\)\s*$/u.test(error.stderr)) throw new CommandWorkerError("ECANCELED", "Command authorization was cancelled.");
			if (object(error) && typeof error.stdout === "string" && error.stdout.trim().startsWith("{")) stdout = error.stdout;
			else throw new CommandWorkerError("EIO", "Command-manager process failed.");
		}
		const response = JSON.parse(stdout.trim());
		if (!object(response) || typeof response.ok !== "boolean") throw new Error("Invalid command-manager response.");
		if (!response.ok) {
			const code = typeof response.code === "string" ? response.code : "EIO";
			if (!elevated && process.platform === "darwin" && operation !== "inspect" && ["EACCES", "EPERM"].includes(code)) return this.worker(operation, expected, true);
			throw new CommandWorkerError(code, typeof response.message === "string" ? response.message : "Command management failed.");
		}
		return parseState(response.state, process.platform);
	}
	async inspect() {
		const state = await this.worker("inspect");
		if (process.platform !== "darwin") return state;
		try {
			return {
				...state,
				...await shellCommand()
			};
		} catch {
			return {
				...state,
				selectionUnknown: true
			};
		}
	}
	async run() {
		const messages = this.options.messages();
		if (!this.options.isPackaged || !this.options.isInstalledLocation()) {
			await this.options.show({
				type: "info",
				title: messages.cliCommandTitle,
				message: messages.cliCommandInstallApp,
				buttons: [messages.cliCommandClose]
			});
			return;
		}
		if (this.options.isInstalling()) {
			await this.options.show({
				type: "info",
				title: messages.cliCommandTitle,
				message: messages.cliCommandUpdating,
				buttons: [messages.cliCommandClose]
			});
			return;
		}
		try {
			const state = await this.inspect();
			const choice = await this.options.show(presentCommandManagement(state, messages, process.platform));
			if (this.options.isQuitting()) return;
			const operation = state.managed ? choice.response === 1 ? "install" : choice.response === 2 ? "remove" : void 0 : choice.response === 0 ? "install" : void 0;
			if (operation === void 0) return;
			const ownsSelection = state.managed && (state.activeCommand === void 0 || sameCommand(state.activeCommand, state.destination, process.platform));
			if (operation === "install" && (state.selectionUnknown || !ownsSelection && (state.occupied || state.activeCommand !== void 0))) {
				if ((await this.options.show({
					type: "warning",
					title: messages.cliCommandTitle,
					message: messages.cliCommandSwitch,
					detail: (state.selectionUnknown ? messages.cliCommandSelectionUnknown : format(messages.cliCommandSelected, state.activeCommand ?? state.destination)) + "\n\n" + messages.cliCommandPreserve,
					buttons: [messages.cliCommandContinue, messages.cancel],
					defaultId: 1,
					cancelId: 1
				})).response !== 0 || this.options.isQuitting()) return;
			}
			const result = await this.worker(operation, state.fingerprint);
			if (this.options.isQuitting()) return;
			const current = await this.inspect();
			const shadowed = current.activeCommand !== void 0 && !sameCommand(current.activeCommand, current.destination, process.platform);
			await this.options.show({
				type: shadowed && operation === "install" ? "warning" : "info",
				title: messages.cliCommandTitle,
				message: operation === "remove" ? messages.cliCommandRemoved : messages.cliCommandInstalled,
				detail: [
					operation === "install" ? messages.cliCommandNewTerminal : state.backup !== void 0 && state.managed ? messages.cliCommandPreviousRestored : messages.cliCommandOtherKept,
					...shadowed && operation === "install" && current.activeCommand !== void 0 ? [format(messages.cliCommandSelected, current.activeCommand), messages.cliCommandShadowed] : [],
					...current.selectionUnknown && operation === "install" ? [messages.cliCommandSelectionUnknown] : [],
					...result.preservedBackup === void 0 ? [] : [format(messages.cliCommandBackupKept, result.preservedBackup)]
				].join("\n\n"),
				buttons: [messages.cliCommandClose]
			});
		} catch (error) {
			if (this.options.isQuitting()) return;
			const code = error instanceof CommandWorkerError ? error.code : "EIO";
			if (code === "ECANCELED") return;
			await this.options.show({
				type: "error",
				title: messages.cliCommandTitle,
				message: code === "ESTALE" ? messages.cliCommandChanged : code === "EOWNERSHIP" ? messages.cliCommandOwnershipError : messages.cliCommandFailed,
				technicalDetails: error instanceof Error ? error.message : "",
				buttons: [messages.cliCommandClose]
			});
		}
	}
};
//#endregion
//#region lib/types/web-document.js
/** Local Web document and authenticated HTTP forwarding for the application window. */
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".woff2": "font/woff2",
	".png": "image/png",
	".ico": "image/x-icon"
};
/**
* Read an application-owned static asset; the index waits for asynchronous Host injections.
* @param request - Local application request.
* @param root - Packaged Web dist directory.
* @returns Static response, or a missing/invalid path response.
*/
async function serveWebDocument(request, root) {
	if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
	const url = new URL(request.url);
	let pathname;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		return new Response(null, { status: 400 });
	}
	const target = resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
	const directory = resolve(root);
	if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 });
	let body;
	try {
		body = await readFile$1(target);
	} catch (error) {
		if (error.code === "ENOENT") return new Response(null, { status: 404 });
		throw error;
	}
	const content = pathname === "/" || pathname === "/index.html" ? body.toString().replace("<head>", "<head><script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()<\/script>") : new Uint8Array(body);
	return new Response(request.method === "HEAD" ? null : content, { headers: { "content-type": MIME[extname(target)] ?? "application/octet-stream" } });
}
/**
* Exchange the Host launch URL for an authority-bound browser cookie.
* @param url - Authenticated URL reported by the owned Host process.
* @returns Cookie header for requests forwarded to that Host.
*/
async function authenticateWebHost(url) {
	const response = await fetch(url, { redirect: "manual" });
	const cookie = response.headers.get("set-cookie");
	await response.body?.cancel();
	if (response.status !== 303 || cookie === null) throw new Error("Desktop Host authentication failed");
	const end = cookie.indexOf(";");
	return end < 0 ? cookie : cookie.slice(0, end);
}
/**
* Remove every `dsh-auth-*` cookie that earlier releases left in a cookie store for the Host's hostname.
* Cookies ignore ports, so cookies from earlier random-port Hosts would otherwise travel with every
* request to that hostname until they expire.
* @param cookies - Electron session cookie store.
* @param url - Host URL; cookies for its hostname on every port are removed.
*/
async function removeLegacyHostCookies(cookies, url) {
	const origin = new URL(url).origin;
	for (const { name } of await cookies.get({ url: origin })) if (name.startsWith("dsh-auth-")) await cookies.remove(origin, name);
}
/**
* Response headers not relayed to the renderer. `set-cookie` would hand the
* Host's authentication cookie to the page's cookie jar, which the shell owns
* instead; the rest describe the Node `fetch` connection (its encoding, length,
* and hop-by-hop transport), which Chromium never sees.
*/
const WITHHELD_RESPONSE_HEADERS = [
	"set-cookie",
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"te",
	"trailer",
	"upgrade",
	"proxy-authenticate",
	"proxy-authorization"
];
/** Host routes whose responses carry immutable cache headers keyed by a per-process revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u;
/**
* Forward local application requests to its authenticated Host, preserving streaming and cancellation.
* Plugin bundle responses lose their `cache-control` for `no-store`: the Host marks them immutable
* under a revision that changes every launch, so Chromium's disk cache would only accumulate bundles
* no later launch can reuse.
* @param request - Request from the application origin.
* @param host - Owned Host URL.
* @param cookie - Host-issued authentication cookie.
* @returns Host response without connection-level headers.
*/
async function forwardWebRequest(request, host, cookie) {
	const source = new URL(request.url);
	const origin = request.headers.get("origin");
	if (origin !== null && origin !== "dsh-app://app") return new Response(null, { status: 403 });
	const target = new URL(host);
	target.pathname = source.pathname;
	target.search = source.search;
	const headers = new Headers(request.headers);
	for (const name of [
		"host",
		"origin",
		"cookie",
		"sec-fetch-site"
	]) headers.delete(name);
	headers.set("cookie", cookie);
	const init = {
		method: request.method,
		headers,
		body: request.body,
		signal: request.signal,
		duplex: "half",
		redirect: "manual"
	};
	const response = await fetch(target, init);
	const outgoing = new Headers(response.headers);
	for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name);
	if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set("cache-control", "no-store");
	return new Response(response.body, {
		status: response.status,
		headers: outgoing
	});
}
//#endregion
//#region lib/types/fatal-recovery.js
/** Native recovery for the first fatal failure in one Desktop process. */
/** Upper bound on waiting for the crash report before the dialog opens. */
const CRASH_REPORT_WAIT_MS = 1e3;
/** The dialog's `detail` budget in characters, within which the native message box stays readable. */
const DETAIL_BUDGET = 1200;
/** At most eight error-tail lines; status, advice and truncation notice share the detail character budget.
* The message heading has its own field.
*/
function dialogDetail(error, messages, reportState) {
	const advice = `\n\n${messages.startupReinstallAdvice}`;
	const report = reportLine(messages, reportState);
	const tail = error.split(/\r\n|[\n\r\u2028\u2029]/u).slice(-8).join("\n");
	const budget = DETAIL_BUDGET - advice.length - report.length - messages.diagnosticTruncated.length - 1;
	const shortened = tail.slice(-budget).replace(/^[\uDC00-\uDFFF]/u, "");
	return `${shortened === error ? error : `${messages.diagnosticTruncated}\n${shortened}`}${report}${advice}`;
}
function reportLine(messages, state) {
	if (state.kind === "pending") return `\n${messages.reportPending}`;
	if (state.kind === "failed") return `\n${messages.reportUnavailable}`;
	return `\n${formatDesktopMessage(messages.reportWrittenTo, { path: state.path })}`;
}
/** Deduplicates fatal reports while keeping explicit recovery-operation failures actionable. */
var DesktopFatalRecovery = class {
	operations;
	reported = false;
	reportState = { kind: "pending" };
	/** @param operations - Native presentation, report persistence, and application-owned shutdown operations. */
	constructor(operations) {
		this.operations = operations;
	}
	/** Whether this process requires a native recovery action before further plugin changes. */
	get active() {
		return this.reported;
	}
	/**
	* Show the first fatal error; later reports cannot replace it or open another dialog.
	* The crash report is written first, bounded by {@link CRASH_REPORT_WAIT_MS}, so the dialog can name it;
	* a slow or failed write shows its status. Retrieving a report rechecks the same write.
	* @param error - Fatal failure, including nested diagnostic causes.
	* @param source - Where the failure surfaced, recorded in the report.
	* @returns Completion of the user's recovery action; duplicate reports resolve immediately.
	*/
	async report(error, source) {
		if (this.reported) return;
		this.reported = true;
		const messages = this.operations.messages();
		const report = this.persist(error, source);
		await this.waitForReport(report);
		let detail = desktopErrorState(error).message;
		let message = messages.fatalSummary;
		for (;;) {
			const addressInUse = /\blisten EADDRINUSE\b/u.test(detail);
			const buttons = addressInUse ? [messages.exitApplication, messages.restartApplication] : [
				messages.exitApplication,
				messages.restartApplication,
				messages.disableThirdPartyPlugins
			];
			const reportButton = this.reportState.kind === "failed" ? void 0 : buttons.length;
			if (reportButton !== void 0) buttons.push(messages.getDiagnosticReport);
			const { response } = await this.operations.show({
				type: "error",
				title: messages.startupFailed,
				message,
				detail: addressInUse ? `${messages.startupAddressInUse}${reportLine(messages, this.reportState)}` : dialogDetail(detail, messages, this.reportState),
				buttons,
				defaultId: 1,
				cancelId: 0,
				noLink: true
			});
			if (response === reportButton) {
				await this.waitForReport(report);
				if (this.reportState.kind === "ready") try {
					await this.operations.revealReport(this.reportState.path);
					message = messages.reportShareHint;
				} catch (failure) {
					console.error("dsh desktop: could not reveal crash report", failure);
					message = messages.reportRevealFailed;
				}
				continue;
			}
			if (response === 0) {
				try {
					await this.operations.stop();
				} catch (failure) {
					console.error(failure);
				}
				this.operations.exit();
				return;
			}
			try {
				await this.operations.stop();
				if (response === 2) await this.operations.disablePlugins();
				this.operations.restart();
				return;
			} catch (failure) {
				console.error(failure);
				message = messages.recoveryOperationFailed;
				detail = desktopErrorState(failure).message;
			}
		}
	}
	async persist(error, source) {
		try {
			const path = await this.operations.writeReport(error, source);
			this.reportState = path === void 0 ? { kind: "failed" } : {
				kind: "ready",
				path
			};
		} catch (failure) {
			console.error("dsh desktop: crash report failed", failure);
			this.reportState = { kind: "failed" };
		}
	}
	async waitForReport(report) {
		let timer;
		try {
			await Promise.race([report, new Promise((resolve) => {
				timer = setTimeout(resolve, CRASH_REPORT_WAIT_MS);
			})]);
		} finally {
			clearTimeout(timer);
		}
	}
};
//#endregion
//#region lib/types/crash-report.js
/**
* Crash report files: the complete diagnostic of one fatal Desktop failure,
* written before the recovery dialog so the dialog can name the file. The
* dialog itself shows only the last lines of the error; the file holds the
* whole error, its enumerable properties and cause chain, the process facts,
* and the renderer's recent error-level console output.
*/
/** File name prefix every report shares. */
const CRASH_REPORT_PREFIX = "crash-";
/** The exact generated file name syntax; pruning touches only files that match it. */
const CRASH_REPORT_NAME = /^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:host|web-boot|renderer|main)\.log$/u;
/** Retained bytes of renderer error-level console output. */
const RENDERER_CONSOLE_MAX_BYTES = 64 * 1024;
/** Upper bound of the rendered error section; a Host exit error already carries a 64 KiB stderr tail in its message. */
const ERROR_SECTION_MAX_CHARS = 256 * 1024;
/**
* Bounded tail of renderer error-level console lines. Lines are dropped from
* the head once the retained byte total exceeds the cap; one oversized line is
* kept whole so a long stack is never cut mid-line.
*/
var RendererConsoleTail = class {
	maxBytes;
	lines = [];
	bytes = 0;
	/** @param maxBytes - retained byte cap across all lines. */
	constructor(maxBytes = RENDERER_CONSOLE_MAX_BYTES) {
		this.maxBytes = maxBytes;
	}
	/**
	* Append one console line.
	* @param line - the formatted console message.
	*/
	push(line) {
		this.lines.push(line);
		this.bytes += Buffer.byteLength(line);
		while (this.lines.length > 1 && this.bytes > this.maxBytes) this.bytes -= Buffer.byteLength(this.lines.shift());
	}
	/** @returns the retained lines, oldest first. */
	snapshot() {
		return [...this.lines];
	}
};
/**
* The report file name: sortable by time, then the source.
* @param time - failure time.
* @param source - where the failure surfaced.
* @returns `crash-<ISO time with ':' and '.' as '-'>-<source>.log`.
*/
function crashReportFileName(time, source) {
	return `${CRASH_REPORT_PREFIX}${time.toISOString().replaceAll(/[:.]/gu, "-")}-${source}.log`;
}
/**
* Render one report as plain text: a header of facts, the inspected error,
* the Host's own diagnostic when it reported one, and the renderer console tail.
* @param input - the failure and its context.
* @returns the complete file content.
*/
function renderCrashReport(input) {
	const header = [
		`time: ${input.time.toISOString()}`,
		`source: ${input.source}`,
		`phase: ${input.phase}`,
		`app: ${input.app.name} ${input.app.version}`,
		`platform: ${input.app.platform} ${input.app.arch}`,
		`electron: ${input.app.electron}`,
		`node: ${input.app.node}`,
		`locale: ${input.app.locale}`,
		`shell pid: ${String(process.pid)}`
	];
	const consoleSection = input.rendererConsole.length === 0 ? "(no error-level renderer console output was captured)" : input.rendererConsole.join("\n");
	return [
		header.join("\n"),
		"",
		"--- error ---",
		boundedErrorSection(input.error),
		"",
		...input.hostDiagnostic === void 0 ? [] : [
			"--- host diagnostic (as reported by the Host process) ---",
			input.hostDiagnostic,
			""
		],
		"--- renderer console (error level, oldest first) ---",
		consoleSection,
		...input.operationHistoryPlanned === true ? [
			"",
			"--- auxiliary diagnostics ---",
			"Operation history is best effort. Without its completion marker below, it is unavailable or incomplete.",
			"Recent operations are context only. Missing records do not establish that no changes occurred."
		] : [],
		""
	].join("\n");
}
function boundedErrorSection(error) {
	const rendered = inspect(error, {
		depth: 6,
		maxStringLength: 64 * 1024,
		maxArrayLength: 100,
		breakLength: 120
	});
	return rendered.length <= 262144 ? rendered : `${rendered.slice(0, ERROR_SECTION_MAX_CHARS)}\n… (error section cut at ${String(ERROR_SECTION_MAX_CHARS)} characters)`;
}
/**
* Write one report into `directory`, creating it when absent. Failure is
* reported to `console.error` and yields `undefined`: the recovery dialog
* proceeds without a file rather than failing over a diagnostic aid.
* @param directory - the application logs directory.
* @param input - the failure and its context.
* @returns the written file path, or `undefined` when writing failed.
*/
async function writeCrashReport(directory, input) {
	const path = join(directory, crashReportFileName(input.time, input.source));
	try {
		await mkdir(directory, {
			recursive: true,
			mode: 448
		});
		await writeFile(path, renderCrashReport(input), {
			mode: 384,
			flag: "wx"
		});
		return path;
	} catch (error) {
		console.error("dsh desktop: crash report could not be written", path, error);
		return;
	}
}
/**
* Delete the oldest reports beyond `retained`, judged by file name order, and
* leave every other file in the directory alone. Failure is reported to
* `console.error`; a missing directory is not a failure.
* @param directory - the application logs directory.
* @param retained - reports to keep.
*/
async function pruneCrashReports(directory, retained = 10) {
	let names;
	try {
		names = await readdir(directory);
	} catch (error) {
		if (error.code === "ENOENT") return;
		console.error("dsh desktop: crash report directory could not be listed", directory, error);
		return;
	}
	const reports = names.filter((name) => CRASH_REPORT_NAME.test(name)).sort();
	const excess = reports.slice(0, Math.max(0, reports.length - retained));
	for (const name of excess) try {
		await unlink(join(directory, name));
	} catch (error) {
		console.error("dsh desktop: stale crash report could not be removed", join(directory, name), error);
	}
}
//#endregion
//#region lib/types/operation-journal.js
/** Single-shell, bounded persistence for already-projected operation diagnostics. */
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Owns two known files and one serial writer; the owning shell must exclude other writers. */
var OperationJournal = class {
	directory;
	limits;
	queue = [];
	queuedBytes = 0;
	dropped = 0;
	failed = 0;
	repairedSegments = 0;
	disabled = false;
	closed = false;
	writing;
	initialized = false;
	abort = new AbortController();
	/**
	* @param directory - Directory reserved for the shell's operation journal.
	* @param limits - Positive byte budgets, with recordBytes no greater than either other budget.
	*/
	constructor(directory, limits) {
		this.directory = directory;
		this.limits = limits;
		if (![
			limits.segmentBytes,
			limits.recordBytes,
			limits.queuedBytes
		].every((value) => Number.isSafeInteger(value) && value > 0) || limits.recordBytes > limits.segmentBytes || limits.recordBytes > limits.queuedBytes) throw new RangeError("Invalid operation journal budgets");
	}
	/**
	* Queue one prevalidated, whitelisted JSON record without awaiting disk I/O.
	* @param record - An already serialized JSON object without literal line delimiters.
	* @returns Whether the record was accepted; disk failures are reported separately by status().
	*/
	enqueue(record) {
		const line = record + "\n";
		const bytes = Buffer.byteLength(line);
		if (this.closed || this.disabled || bytes > this.limits.recordBytes || bytes + this.queuedBytes > this.limits.queuedBytes || /[\r\n]/u.test(record)) {
			this.dropped++;
			return false;
		}
		this.queue.push(line);
		this.queuedBytes += bytes;
		this.startWriter();
		return true;
	}
	/** @returns Current queue occupancy and omission counters. */
	status() {
		return {
			dropped: this.dropped,
			failed: this.failed,
			queuedBytes: this.queuedBytes,
			disabled: this.disabled,
			repairedSegments: this.repairedSegments
		};
	}
	/** Stop accepting records and await completion of the owned writer. */
	async close() {
		this.closed = true;
		while (this.writing !== void 0) await this.writing;
	}
	/**
	* Wait for queued records during shutdown or installer handoff without holding the application indefinitely.
	* @param timeoutMs - Waiting budget before disabling the writer and cancelling subsequent I/O.
	* @returns True after the queue settles successfully; false immediately when disabled, or on failure or deadline.
	* False does not confirm that an issued OS request has settled.
	*/
	async drain(timeoutMs) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("Invalid journal drain deadline");
		if (this.disabled) return false;
		let timer;
		try {
			return await Promise.race([(async () => {
				while (this.writing !== void 0) await this.writing;
				return !this.disabled;
			})(), new Promise((resolve) => {
				timer = setTimeout(() => {
					this.disabled = true;
					this.abort.abort();
					resolve(false);
				}, timeoutMs);
			})]);
		} finally {
			clearTimeout(timer);
		}
	}
	startWriter() {
		this.writing ??= this.writeQueue().finally(() => {
			this.writing = void 0;
			if (this.queue.length > 0) this.startWriter();
		});
	}
	async writeQueue() {
		try {
			await mkdir(this.directory, {
				recursive: true,
				mode: 448
			});
			this.abort.signal.throwIfAborted();
			const current = join(this.directory, "operations.jsonl");
			const previous = join(this.directory, "operations.previous.jsonl");
			if (!this.initialized) {
				await this.prepareSegments(current, previous);
				this.initialized = true;
			}
			for (let line = this.queue[0]; line !== void 0; line = this.queue[0]) {
				this.abort.signal.throwIfAborted();
				const bytes = Buffer.byteLength(line);
				let size = 0;
				try {
					size = (await stat(current)).size;
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				}
				this.abort.signal.throwIfAborted();
				if (size > this.limits.segmentBytes) {
					await writeFile(current, "", { mode: 384 });
					this.repairedSegments++;
				} else if (size + bytes > this.limits.segmentBytes) await rename(current, previous);
				this.abort.signal.throwIfAborted();
				await writeFile(current, line, {
					flag: "a",
					mode: 384,
					signal: this.abort.signal
				});
				this.queue.shift();
				this.queuedBytes -= bytes;
			}
		} catch (_error) {
			this.disabled = true;
			this.failed += this.queue.length;
			this.queue.length = 0;
			this.queuedBytes = 0;
		}
	}
	async prepareSegments(current, previous) {
		try {
			const size = (await stat(previous)).size;
			this.abort.signal.throwIfAborted();
			if (size > this.limits.segmentBytes) {
				await writeFile(previous, "", { mode: 384 });
				this.repairedSegments++;
			}
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		this.abort.signal.throwIfAborted();
		{
			const env_1 = {
				stack: [],
				error: void 0,
				hasError: false
			};
			try {
				const handle = __addDisposableResource(env_1, await open(current, "r+").catch((error) => {
					if (error.code !== "ENOENT") throw error;
					this.abort.signal.throwIfAborted();
					return open(current, "wx+", 384);
				}), true);
				this.abort.signal.throwIfAborted();
				const size = (await handle.stat()).size;
				this.abort.signal.throwIfAborted();
				if (size > this.limits.segmentBytes) {
					await handle.truncate(0);
					this.repairedSegments++;
				} else if (size > 0) {
					const byte = Buffer.alloc(1);
					if ((await handle.read(byte, 0, 1, size - 1)).bytesRead !== 1 || byte[0] !== 10) {
						const buffer = Buffer.alloc(size);
						let offset = 0;
						while (offset < size) {
							this.abort.signal.throwIfAborted();
							const chunk = await handle.read(buffer, offset, size - offset, offset);
							if (chunk.bytesRead === 0) break;
							offset += chunk.bytesRead;
						}
						this.abort.signal.throwIfAborted();
						await handle.truncate(buffer.subarray(0, offset).lastIndexOf(10) + 1);
						this.repairedSegments++;
					}
				}
			} catch (e_1) {
				env_1.error = e_1;
				env_1.hasError = true;
			} finally {
				const result_1 = __disposeResources(env_1);
				if (result_1) await result_1;
			}
		}
		this.abort.signal.throwIfAborted();
	}
};
//#endregion
//#region lib/types/operation-report-job.js
/** Worker lifetime for an auxiliary report; completion includes worker exit. */
/**
* Collect history, request cooperative cancellation, then force termination if cleanup exceeds its budget.
* @param input - Bounded collection request for an existing basic report.
* @param options - Total deadline and the cleanup window reserved within it.
* @param signal - Application shutdown or recovery cancellation; an already-aborted signal prevents startup.
* @returns Append outcome only after Worker exit; cancellation or termination requests alone do not confirm exit.
*/
async function runOperationReportJob(input, options, signal) {
	const { timeoutMs, cancellationGraceMs } = options;
	if (!Number.isSafeInteger(timeoutMs) || !Number.isSafeInteger(cancellationGraceMs) || cancellationGraceMs < 1 || timeoutMs <= cancellationGraceMs) throw new RangeError("Invalid operation report deadlines");
	if (signal.aborted) return {
		appended: false,
		timedOut: false,
		cancelled: true
	};
	const terminationDeadline = performance.now() + timeoutMs;
	let worker;
	try {
		worker = new Worker(new URL("./operation-report-worker.js", import.meta.url), {
			workerData: input,
			resourceLimits: {
				maxOldGenerationSizeMb: 32,
				maxYoungGenerationSizeMb: 8,
				stackSizeMb: 2
			}
		});
	} catch (_error) {
		return {
			appended: false,
			timedOut: false,
			cancelled: false
		};
	}
	return new Promise((resolve) => {
		let appended = false;
		let failed = false;
		let timedOut = false;
		let cancelled = false;
		let terminationTimer;
		const terminateWorker = () => {
			worker.terminate().catch(() => {
				failed = true;
			});
		};
		const requestCancellation = () => {
			if (cancelled) return;
			cancelled = true;
			clearTimeout(collectionTimer);
			try {
				worker.postMessage("cancel");
			} catch (_error) {
				failed = true;
			}
			terminationTimer = setTimeout(terminateWorker, Math.max(0, Math.min(cancellationGraceMs, terminationDeadline - performance.now())));
		};
		const collectionTimer = setTimeout(() => {
			timedOut = true;
			requestCancellation();
		}, Math.max(0, terminationDeadline - performance.now() - cancellationGraceMs));
		signal.addEventListener("abort", requestCancellation, { once: true });
		worker.on("message", (message) => {
			appended = message === true;
		});
		worker.once("error", () => {
			failed = true;
		});
		worker.once("exit", (code) => {
			clearTimeout(collectionTimer);
			clearTimeout(terminationTimer);
			signal.removeEventListener("abort", requestCancellation);
			resolve({
				appended: appended && code === 0 && !failed && !cancelled,
				timedOut,
				cancelled
			});
		});
		if (signal.aborted) requestCancellation();
	});
}
//#endregion
//#region lib/types/welcome-api.js
/** Operations available to the isolated native welcome renderer. */
/** Private native welcome channels, installed only while its window exists. */
const WELCOME_IPC = {
	saveApiKey: "dsh-welcome:save-api-key",
	analytics: "dsh-welcome:analytics",
	analyticsEnabled: "dsh-welcome:analytics-enabled",
	skip: "dsh-welcome:skip",
	start: "dsh-welcome:start",
	cancel: "dsh-welcome:cancel",
	copyLink: "dsh-welcome:copy-link",
	state: "dsh-welcome:state",
	takeNotice: "dsh-welcome:take-notice"
};
/**
* Decide whether a startup or sign-out requires the welcome entry.
* @param authentication - current account and independently stored API-key facts.
* @returns true only when neither authentication route is configured.
*/
function needsWelcome(authentication) {
	return !authentication.loggedIn && !authentication.hasApiKey;
}
//#endregion
//#region lib/types/welcome-window.js
/** Native welcome window and its presentation-only renderer. */
/**
* Resolve the fixed-size welcome window's native material and controls.
* @param platform - operating system hosting Electron.
* @param locale - shell-owned localized copy.
* @returns sandboxed window options with a locale-only preload.
*/
function welcomeWindowOptions(platform, locale) {
	return {
		width: 600,
		height: 700,
		useContentSize: true,
		center: true,
		resizable: false,
		maximizable: false,
		fullscreenable: false,
		show: false,
		title: locale.messages.welcomeTitle,
		backgroundColor: platform === "darwin" || platform === "win32" ? "#00000000" : "#FFFFFF",
		...platform === "darwin" ? {
			titleBarStyle: "hidden",
			trafficLightPosition: {
				x: 21,
				y: 21
			},
			vibrancy: "menu",
			visualEffectState: "active"
		} : {},
		...platform === "win32" ? {
			titleBarStyle: "hidden",
			titleBarOverlay: {
				color: "#00000000",
				symbolColor: "#0F1115",
				height: 42
			},
			backgroundMaterial: "acrylic"
		} : {},
		webPreferences: {
			preload: fileURLToPath(new URL("./preload-welcome.cjs", import.meta.url)),
			additionalArguments: [`--dsh-welcome-locale=${locale.id}`],
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webSecurity: true
		}
	};
}
let disposeActiveHandlers;
/**
* Open the process's sole welcome window with desktop-owned operations.
* Replaces IPC ownership immediately; the caller closes the previous native window.
* @param locale - shell-owned localized copy.
* @param operations - credential write and this-launch-only skip actions.
* @returns the visible window; a failed load destroys it before rejecting.
*/
async function openWelcomeWindow(locale, operations) {
	const window = new BrowserWindow(welcomeWindowOptions(process.platform, locale));
	disposeActiveHandlers?.();
	let active = true;
	const disposeHandlers = () => {
		if (!active) return;
		active = false;
		for (const channel of [
			WELCOME_IPC.analyticsEnabled,
			WELCOME_IPC.analytics,
			WELCOME_IPC.takeNotice,
			WELCOME_IPC.saveApiKey,
			WELCOME_IPC.skip,
			WELCOME_IPC.start,
			WELCOME_IPC.cancel,
			WELCOME_IPC.copyLink
		]) ipcMain.removeHandler(channel);
		disposeActiveHandlers = void 0;
	};
	disposeActiveHandlers = disposeHandlers;
	const assertSender = (event) => {
		if (!active || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("desktop welcome: rejected action from an unowned frame");
	};
	ipcMain.handle(WELCOME_IPC.analyticsEnabled, (event) => {
		assertSender(event);
		return operations.analyticsEnabled();
	});
	ipcMain.handle(WELCOME_IPC.analytics, async (event, eventName, attributes) => {
		assertSender(event);
		if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) throw new Error("desktop welcome: invalid analytics attributes");
		if (eventName === "auth_page_click" && "button_name" in attributes && Object.keys(attributes).length === 1 && (attributes.button_name === "sign_in" || attributes.button_name === "api-key")) await operations.analytics?.(eventName, { button_name: attributes.button_name });
		else if ((eventName === "auth_page_view" || eventName === "api_key_save_click") && Object.keys(attributes).length === 0) await operations.analytics?.(eventName, {});
		else throw new Error("desktop welcome: invalid analytics event");
	});
	ipcMain.handle(WELCOME_IPC.takeNotice, async (event) => {
		assertSender(event);
		return operations.takeNotice();
	});
	ipcMain.handle(WELCOME_IPC.saveApiKey, async (event, value) => {
		assertSender(event);
		if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value)) return { ok: false };
		return operations.saveApiKey(value);
	});
	ipcMain.handle(WELCOME_IPC.skip, async (event) => {
		assertSender(event);
		await operations.skip();
	});
	ipcMain.handle(WELCOME_IPC.start, async (event) => {
		assertSender(event);
		return operations.startSignIn();
	});
	ipcMain.handle(WELCOME_IPC.cancel, async (event, id) => {
		assertSender(event);
		if (typeof id !== "string") throw new Error("desktop welcome: invalid attempt");
		return operations.cancelSignIn(id);
	});
	ipcMain.handle(WELCOME_IPC.copyLink, async (event, id) => {
		assertSender(event);
		if (typeof id !== "string") throw new Error("desktop welcome: invalid attempt");
		return operations.copySignInLink(id);
	});
	window.once("closed", disposeHandlers);
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event) => {
		event.preventDefault();
	});
	try {
		await window.loadFile(join(app.getAppPath(), "renderer", "welcome.html"));
	} catch (error) {
		disposeHandlers();
		if (!window.isDestroyed()) window.destroy();
		throw error;
	}
	if (active && !window.isDestroyed()) {
		window.show();
		operations.analytics?.("auth_page_view", {});
	}
	return window;
}
//#endregion
//#region lib/types/account-backend.js
/** Native account commands and Gateway state stream; no renderer receives credentials. */
/** Decode the UI-safe state received across HTTP or WebSocket. @param value - wire value. @returns account projection. */
function accountView(value) {
	if (typeof value !== "object" || value === null || !("status" in value) || !["signed-out", "credential-stored"].includes(String(value.status)) || !("attempt" in value)) throw new Error("desktop account: invalid state");
	if (!("links" in value) || typeof value.links !== "object" || value.links === null || !("usageUrl" in value.links) || typeof value.links.usageUrl !== "string" || !("topUpUrl" in value.links) || typeof value.links.topUpUrl !== "string") throw new Error("desktop account: invalid platform links");
	validateBrowserDestination(value.links.usageUrl);
	validateBrowserDestination(value.links.topUpUrl);
	const attempt = value.attempt;
	if (attempt !== null && (typeof attempt !== "object" || !("id" in attempt) || typeof attempt.id !== "string" || !("phase" in attempt) || ![
		"initializing",
		"waiting-browser",
		"exchanging",
		"committing",
		"succeeded",
		"cancelled",
		"expired",
		"failed"
	].includes(String(attempt.phase)) || "authorizeUrl" in attempt && typeof attempt.authorizeUrl !== "string" || "expiresAt" in attempt && (typeof attempt.expiresAt !== "number" || !Number.isFinite(attempt.expiresAt)) || "errorCode" in attempt && ![
		"no-response",
		"network",
		"protocol",
		"expired",
		"storage"
	].includes(String(attempt.errorCode)))) throw new Error("desktop account: invalid attempt");
	if (attempt !== null && "authorizeUrl" in attempt) validateBrowserDestination(String(attempt.authorizeUrl));
	const parsed = value;
	return {
		status: parsed.status,
		links: {
			usageUrl: parsed.links.usageUrl,
			topUpUrl: parsed.links.topUpUrl
		},
		attempt: parsed.attempt === null ? null : {
			id: parsed.attempt.id,
			phase: parsed.attempt.phase,
			...parsed.attempt.authorizeUrl === void 0 ? {} : { authorizeUrl: parsed.attempt.authorizeUrl },
			...parsed.attempt.expiresAt === void 0 ? {} : { expiresAt: parsed.attempt.expiresAt },
			...parsed.attempt.errorCode === void 0 ? {} : { errorCode: parsed.attempt.errorCode }
		}
	};
}
/** Only HTTP loopback or HTTPS destinations can leave the native app. */
function validateBrowserDestination(value) {
	const url = new URL(value);
	const loopback = [
		"localhost",
		"127.0.0.1",
		"[::1]"
	].includes(url.hostname);
	if (url.username || url.password || !(url.protocol === "https:" || loopback && url.protocol === "http:")) throw new Error("desktop account: invalid browser destination");
}
/**
* Connect native account operations to the standard authenticated Web backend.
* @param origin - Host Web origin.
* @param invoke - validated unary RPC caller.
* @param cookie - Host authentication Cookie header for the account WebSocket.
* @returns account operations; watch callers own their subscriptions.
*/
function desktopAccountBackend(origin, invoke, cookie) {
	const call = async (method, args = {}) => accountView(await invoke({
		namespace: "account",
		method,
		args
	}));
	return {
		state: () => call("getState"),
		start: (client) => call("startSignIn", {
			client,
			callbackOrigin: new URL(origin).origin,
			loginSource: "desktop"
		}),
		cancel: (attemptId) => call("cancelSignIn", { attemptId }),
		signOut: (client) => call("signOut", { client }),
		watch(listener, failed, expired, onAnalyticsEnabledChanged) {
			let closed = false;
			let socket;
			let retry;
			const connect = () => {
				const streamId = randomUUID();
				const expiryStreamId = randomUUID();
				const analyticsPolicyStreamId = randomUUID();
				const url = new URL(REMOTE_STREAM_MUX_PATH, origin);
				url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
				socket = new WebSocket(url, {
					headers: {
						cookie,
						origin
					},
					maxPayload: 65536
				});
				socket.on("open", () => {
					if (onAnalyticsEnabledChanged !== void 0) socket?.send(JSON.stringify({
						type: "open",
						streamId: analyticsPolicyStreamId,
						endpoint: "productAnalytics/watchPolicy",
						payload: { args: {} }
					}));
					socket?.send(JSON.stringify({
						type: "open",
						streamId: expiryStreamId,
						endpoint: "account/watchExpiry",
						payload: { args: {} }
					}));
					socket?.send(JSON.stringify({
						type: "open",
						streamId,
						endpoint: "account/watch",
						payload: { args: {} }
					}));
				});
				socket.on("message", (data) => {
					try {
						const frame = parseRemoteStreamServerMessage((Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("utf8"));
						if (frame.streamId === analyticsPolicyStreamId) {
							if (frame.type === "item" && typeof frame.value === "boolean") onAnalyticsEnabledChanged?.(frame.value);
							else onAnalyticsEnabledChanged?.(false);
							return;
						}
						if (frame.streamId === expiryStreamId && frame.type === "item" && frame.value === "session-expired") {
							expired();
							return;
						}
						if (frame.streamId !== streamId) throw new Error("desktop account: unexpected stream");
						if (frame.type === "item") {
							const update = frame.value;
							if (typeof update !== "object" || update === null || !("type" in update) || update.type !== "snapshot" && update.type !== "credentials-changed" || !("state" in update)) throw new Error("desktop account: invalid stream update");
							listener(accountView(update.state));
						} else socket?.close();
					} catch {
						socket?.close();
					}
				});
				socket.on("error", () => {
					socket?.close();
				});
				socket.on("close", () => {
					if (!closed) {
						onAnalyticsEnabledChanged?.(false);
						failed();
						retry = setTimeout(connect, 1e3);
					}
				});
			};
			connect();
			return () => {
				closed = true;
				onAnalyticsEnabledChanged?.(false);
				clearTimeout(retry);
				socket?.close();
			};
		}
	};
}
//#endregion
//#region lib/types/welcome-backend.js
/** Native welcome operations using the shared Web authentication and RPC APIs. */
function record$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Connect the native HTTP client to the Desktop Host; every request sends `cookie` explicitly and uses no cookie jar.
* @param hostUrl - URL of the running Desktop Host; only its origin is used.
* @param cookie - Cookie header returned by `authenticateWebHost` for this Host.
* @param send - HTTP client for Host requests.
* @returns metadata reads and write-only credential operations over standard RPC.
*/
function connectDesktopWelcome(hostUrl, cookie, send = fetch) {
	const origin = new URL(hostUrl).origin;
	const invoke = async (request, signal) => {
		const rpcId = randomUUID();
		const method = `${request.namespace}/${request.method}`;
		const response = await send(new URL(`/api/${method}`, origin).href, {
			method: "POST",
			redirect: "error",
			...signal === void 0 ? {} : { signal },
			headers: {
				"content-type": "application/json",
				cookie
			},
			body: JSON.stringify({
				type: "client-request",
				rpcId,
				method,
				payload: { args: request.args }
			})
		});
		if (!response.ok) throw new Error("desktop welcome: Web request failed");
		const envelope = await response.json();
		if (!record$2(envelope) || envelope.type !== "server-response" || envelope.rpcId !== rpcId || !record$2(envelope.result) || envelope.result.ok !== true) throw new Error("desktop welcome: Web RPC failed");
		return envelope.result.value;
	};
	const account = desktopAccountBackend(origin, invoke, cookie);
	const settingsAndReference = async () => {
		const settings = await invoke({
			namespace: "settings",
			method: "describe",
			args: {}
		});
		if (!record$2(settings) || !Array.isArray(settings.namespaces)) throw new Error("desktop welcome: missing settings namespaces");
		const official = settings.namespaces.find((item) => record$2(item) && item.ns === "llm-deepseek");
		if (official === void 0) return {
			settings: { namespaces: settings.namespaces },
			ref: void 0
		};
		if (!record$2(official) || !record$2(official.value) || typeof official.value.apiKeyEnv !== "string") throw new Error("desktop welcome: missing official DeepSeek credential reference");
		return {
			settings: { namespaces: settings.namespaces },
			ref: official.value.apiKeyEnv
		};
	};
	const localePreference = (namespaces) => {
		const locale = namespaces.find((item) => record$2(item) && item.ns === "locale");
		if (!record$2(locale) || !record$2(locale.value) || locale.value.preference !== void 0 && typeof locale.value.preference !== "string") throw new Error("desktop welcome: invalid locale preference");
		return locale.value.preference ?? null;
	};
	const themePreference = (namespaces) => {
		const theme = namespaces.find((item) => record$2(item) && item.ns === "ui-theme");
		if (theme === void 0) return "system";
		const preference = record$2(theme) && record$2(theme.value) ? theme.value.preference : void 0;
		if (preference === "light" || preference === "dark" || preference === "system") return preference;
		console.warn("desktop appearance: invalid Host theme preference; using system appearance");
		return "system";
	};
	const read = async () => {
		const { settings, ref } = await settingsAndReference();
		const providers = await invoke({
			namespace: "llm",
			method: "listConfigurableProviders",
			args: {}
		});
		if (!Array.isArray(providers)) throw new Error("desktop welcome: invalid provider directory");
		const namespaces = settings.namespaces;
		const refs = providers.flatMap((provider) => {
			if (!record$2(provider) || typeof provider.settingsNs !== "string" || !Array.isArray(provider.settingsPath)) throw new Error("desktop welcome: invalid provider settings address");
			const namespace = namespaces.find((item) => record$2(item) && item.ns === provider.settingsNs);
			let value = record$2(namespace) ? namespace.value : void 0;
			for (const key of provider.settingsPath) {
				if (typeof key !== "string") throw new Error("desktop welcome: invalid provider settings path");
				value = record$2(value) ? value[key] : void 0;
			}
			return record$2(value) && typeof value.apiKeyEnv === "string" ? [value.apiKeyEnv] : [];
		});
		const unique = [...new Set([...ref === void 0 ? [] : [ref], ...refs])];
		const states = {};
		for (let offset = 0; offset < unique.length; offset += 64) {
			const batch = await invoke({
				namespace: "credentials",
				method: "describe",
				args: { refs: unique.slice(offset, offset + 64) }
			});
			if (!record$2(batch)) throw new Error("desktop welcome: invalid credential metadata");
			Object.assign(states, batch);
		}
		if (ref !== void 0 && !record$2(states[ref])) throw new Error("desktop welcome: missing credential metadata");
		return {
			loggedIn: (await account.state()).status === "credential-stored",
			hasApiKey: Object.values(states).some((value) => record$2(value) && value.configured === true),
			writable: ref !== void 0 && record$2(states[ref]) && states[ref].writable === true,
			localePreference: localePreference(namespaces),
			themePreference: themePreference(namespaces)
		};
	};
	return {
		account,
		read,
		async analyticsEnabled() {
			const enabled = await invoke({
				namespace: "productAnalytics",
				method: "enabled",
				args: {}
			}, AbortSignal.timeout(1e3));
			if (typeof enabled !== "boolean") throw new Error("desktop analytics: invalid collection policy");
			return enabled;
		},
		async report(event) {
			await invoke({
				namespace: "productAnalytics",
				method: "report",
				args: { event }
			}, AbortSignal.timeout(1e3));
		},
		async readLocalePreference() {
			const settings = await invoke({
				namespace: "settings",
				method: "describe",
				args: {}
			});
			if (!record$2(settings) || !Array.isArray(settings.namespaces)) throw new Error("desktop welcome: missing settings namespaces");
			return localePreference(settings.namespaces);
		},
		async save(apiKey) {
			if (!/^[\x21-\x7e]+$/.test(apiKey)) return { ok: false };
			try {
				const { ref } = await settingsAndReference();
				if (ref === void 0) return { ok: false };
				await invoke({
					namespace: "credentials",
					method: "set",
					args: {
						ref,
						value: apiKey
					}
				});
				return { ok: true };
			} catch {
				return { ok: false };
			}
		}
	};
}
//#endregion
//#region lib/types/update-journal.js
/** Opt-in qualification evidence outside the installation directory; no raw diagnostics or request data. */
const ERROR_CODES = [
	"ETIMEDOUT",
	"ENOSPC",
	"ERR_INTERNET_DISCONNECTED",
	"ERR_CONNECTION_RESET",
	"ERR_CONNECTION_CLOSED",
	"ERR_NAME_NOT_RESOLVED",
	"ERR_UPDATER_INVALID_SIGNATURE",
	"ERR_UPDATER_CHECKSUM_MISMATCH"
];
/**
* Whitelist one update state for disk; neither error text nor unexpected object fields survive.
* @param state Main-process-owned update state.
* @returns Only phase, target version, integer progress, operation, and a fixed error classification.
*/
function desktopUpdateJournalState(state) {
	return {
		phase: state.phase,
		...state.version !== void 0 ? { targetVersion: state.version } : {},
		...state.phase === "downloading" && state.percent !== void 0 ? { percent: Math.floor(state.percent) } : {},
		...state.phase === "error" ? {
			failedOperation: state.failedOperation,
			errorCode: ERROR_CODES.find((code) => state.message?.includes(code)) ?? "UNCLASSIFIED"
		} : {}
	};
}
/** Process-owned JSONL evidence; each append is flushed before the caller continues. */
var DesktopUpdateJournal = class {
	version;
	path;
	sequence = 0;
	previousState;
	/**
	* @param directory Absolute evidence directory, retained across installs; creation errors stop qualification.
	* @param version Installed application version, not a version supplied by the feed.
	*/
	constructor(directory, version) {
		this.version = version;
		if (!isAbsolute(directory)) throw new Error("desktop update journal: directory must be absolute");
		mkdirSync(directory, { recursive: true });
		this.path = join(directory, `${Date.now()}-${randomUUID()}.jsonl`);
		writeFileSync(this.path, "", {
			flag: "wx",
			mode: 384,
			flush: true
		});
		this.action("started");
	}
	/**
	* Append a fixed action; failures propagate so incomplete qualification is never reported as traced.
	* @param action Update operation or process milestone; no free-text fields are accepted.
	* @returns Nothing after the record has been flushed.
	*/
	action(action) {
		this.append({ event: action });
	}
	/**
	* Retain state changes and integer progress increments without raw errors, URLs, or request data.
	* @param state Main-process-owned update state.
	* @returns Nothing after the changed state has been flushed; duplicate states add no record.
	*/
	state(state) {
		const fields = desktopUpdateJournalState(state);
		const encoded = JSON.stringify(fields);
		if (encoded === this.previousState) return;
		this.append({
			event: "state",
			...fields
		});
		this.previousState = encoded;
	}
	append(fields) {
		appendFileSync(this.path, `${JSON.stringify({
			schemaVersion: 1,
			sequence: this.sequence++,
			time: (/* @__PURE__ */ new Date()).toISOString(),
			pid: process.pid,
			version: this.version,
			...fields
		})}\n`, { flush: true });
	}
};
//#endregion
//#region lib/types/update-schedule.js
/** Ordinary feed polling; policy queries and user-authorized transfers keep their own lifetimes. */
/**
* Resolve ordinary-update polling settings without changing mandatory-policy scheduling.
* @param env - Desktop process environment.
* @returns Validated durations and fractional jitter.
*/
function resolveDesktopUpdateScheduleConfig(env) {
	const intervalMs = resolveDurationMs(env, "DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS", 6e5);
	const maxBackoffMs = resolveDurationMs(env, "DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS", Math.max(intervalMs, 36e5));
	const jitter = Number(env.DSH_DESKTOP_UPDATE_CHECK_JITTER ?? .2);
	if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1 || maxBackoffMs < intervalMs) throw new Error("desktop update: check jitter must be in [0, 1] and max backoff must cover the check interval");
	return {
		intervalMs,
		maxBackoffMs,
		jitter
	};
}
/** One completion-based deadline shared by periodic, foreground, resume, and explicit checks. */
var DesktopUpdateSchedule = class {
	updates;
	config;
	random;
	now;
	timer;
	pending;
	activeChecks = 0;
	disposed = false;
	nextCheck = -Infinity;
	delay;
	/**
	* @param updates - Coordinator that joins network checks and retains prepared packages.
	* @param config - Validated polling options.
	* @param random - Instance-local uniform sample in [0, 1).
	* @param now - Monotonic milliseconds, independent of wall-clock corrections.
	*/
	constructor(updates, config, random = Math.random, now = () => performance.now()) {
		this.updates = updates;
		this.config = config;
		this.random = random;
		this.now = now;
		this.delay = config.intervalMs;
	}
	/**
	* Start immediately when due; explicit requests bypass the deadline and share in-flight work.
	* @param manual - Whether a check failure must be visible, including when joining an automatic request.
	* @param force - Whether policy arrival or explicit intent bypasses the automatic deadline.
	* @returns Current state when not due, otherwise the coordinator result. Disposal rejects new work.
	*/
	async check(manual = false, force = manual) {
		if (this.disposed) throw new Error("desktop update: polling is disposed");
		if (this.pending !== void 0 && !manual) return this.pending;
		if (!force && this.now() < this.nextCheck) return this.updates.state;
		clearTimeout(this.timer);
		this.timer = void 0;
		this.activeChecks++;
		this.pending = Promise.resolve().then(() => {
			if (this.disposed) throw new Error("desktop update: polling is disposed");
			return this.updates.check(manual);
		}).then((state) => {
			this.complete(state.phase === "error" && state.failedOperation === "check");
			return state;
		}, (error) => {
			this.complete(true);
			throw error;
		});
		return this.pending;
	}
	/** Stop timers and prevent late completion from rearming; the coordinator owns pending network teardown. */
	dispose() {
		this.disposed = true;
		clearTimeout(this.timer);
		this.timer = void 0;
	}
	complete(failed) {
		if (--this.activeChecks !== 0) return;
		this.pending = void 0;
		this.schedule(failed);
	}
	schedule(failed) {
		if (this.disposed) return;
		const { intervalMs, maxBackoffMs, jitter } = this.config;
		this.delay = failed ? Math.min(maxBackoffMs, this.delay * 2) : intervalMs;
		const lower = Math.max(1e3, this.delay * (1 - jitter));
		const upper = Math.min(maxBackoffMs, this.delay * (1 + jitter));
		const delay = Math.round(lower + (upper - lower) * this.random());
		this.nextCheck = this.now() + delay;
		this.timer = setTimeout(() => {
			this.check(false, true).catch((error) => {
				console.error(error);
			});
		}, delay);
	}
};
//#endregion
//#region lib/types/update-presentation.js
const NETWORK_FAILURE = /\b(?:ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT)\b/u;
/**
* Classify one updater failure for both native and Web-localized summaries.
* @param state Update failure and its operation.
* @returns Stable presentation kind without raw diagnostics.
*/
function desktopUpdateFailureKind(state) {
	if (state.failedOperation === "configuration") return "configuration";
	if (state.failedOperation === "install" && state.preparationFailure !== void 0) return state.preparationFailure;
	if (state.failedOperation === "download" && state.downloadFailure !== void 0) return `download-${state.downloadFailure}`;
	const operation = state.failedOperation ?? "install";
	return NETWORK_FAILURE.test(state.message ?? "") ? `${operation}-network` : operation;
}
/**
* Select user-facing error copy independently of raw updater diagnostics.
* @param state Update failure and its operation.
* @param messages Selected shell locale.
* @returns Localized summary suitable for both a dialog and a tooltip.
*/
function desktopUpdateErrorSummary(state, messages) {
	const kind = desktopUpdateFailureKind(state);
	return {
		configuration: messages.updateConfigurationFailed,
		check: messages.updateCheckFailed,
		"check-network": messages.updateCheckNetworkFailed,
		download: messages.updateDownloadFailed,
		"download-space": messages.updateDownloadSpaceFailed,
		"download-permission": messages.updateDownloadPermissionFailed,
		"download-busy": messages.updateDownloadBusyFailed,
		"download-network": messages.updateDownloadNetworkFailed,
		install: messages.updateInstallFailed,
		"install-network": messages.updateInstallNetworkFailed,
		"stop-failed": messages.updateStopFailed,
		"tasks-changed": messages.updateTasksChanged,
		"tasks-unavailable": messages.updateTasksUnavailable,
		"fullscreen-timeout": messages.updateFullscreenTimeout
	}[kind];
}
/**
* @param state - Main-process updater state.
* @returns Semantic status without localized copy, diagnostics, or installation controls.
*/
function presentDesktopUpdate(state) {
	return {
		phase: state.phase,
		...state.version === void 0 ? {} : { version: state.version },
		...state.percent === void 0 ? {} : { percent: Math.floor(state.percent) },
		...state.phase === "error" ? { failure: desktopUpdateFailureKind(state) } : {}
	};
}
//#endregion
//#region lib/types/login-shell-environment.js
/** Login-shell environment for POSIX Desktop launches that inherit only the session manager's environment. */
const DELIMITER = "_DSH_SHELL_ENV_DELIMITER_";
const MARKER = Buffer.from(`\0${DELIMITER}\0`);
const DUMP = `printf '\\0%s\\0' '${DELIMITER}'; command env -0 || exit; printf '\\0%s\\0' '${DELIMITER}'; exit`;
const FALLBACK_SHELLS = [
	"/bin/zsh",
	"/bin/bash",
	"/bin/sh"
];
/** Keep oh-my-zsh update prompts and tmux autostart plugins from blocking a non-terminal read. */
const PROBE_ENVIRONMENT = {
	DISABLE_AUTO_UPDATE: "true",
	ZSH_TMUX_AUTOSTARTED: "true",
	ZSH_TMUX_AUTOSTART: "false"
};
/** Variables that describe the probe shell process rather than the user's configuration. */
const SHELL_SESSION_KEYS = new Set([
	"PWD",
	"OLDPWD",
	"SHLVL",
	"_",
	...Object.keys(PROBE_ENVIRONMENT)
]);
/** Desktop resolves paths such as `DSH_HOME` before the read, so the Host keeps the same inherited values. */
const LAUNCHER_OWNED_PREFIXES = ["DSH_", "ELECTRON_"];
/**
* Resolve login-shell read settings.
* @param env - Desktop process environment.
* @returns Validated per-candidate deadline; `DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS` defaults to 10000.
*/
function resolveDesktopLoginShellConfig(env) {
	return { timeoutMs: resolveDurationMs(env, "DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS", 1e4) };
}
/**
* Candidate shells in order: the account record's login shell (not `$SHELL`), then fixed system shells.
* @returns Distinct absolute candidates; only the fixed shells when the account record is unreadable or empty.
*/
function loginShellCandidates() {
	let account = null;
	try {
		account = userInfo().shell;
	} catch (_error) {}
	return [...new Set([...account === null || account === "" ? [] : [account], ...FALLBACK_SHELLS])];
}
/**
* Extract the variables printed between the two delimiters of the dump command.
* @param stdout - Probe output, including anything rc files printed around the dump.
* @returns Variables, or undefined when both delimiters are not present.
*/
function parseLoginShellOutput(stdout) {
	const parts = stdout.split("\0");
	const first = parts.indexOf(DELIMITER);
	const last = parts.lastIndexOf(DELIMITER);
	if (first === -1 || first === last) return void 0;
	const variables = {};
	for (const entry of parts.slice(first + 1, last)) {
		const separator = entry.indexOf("=");
		if (separator > 0) variables[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	return variables;
}
/**
* Overlay login-shell variables on the inherited environment; shell values win except for
* probe-session variables and launcher-owned `DSH_*` / `ELECTRON_*` names.
* @param base - Environment Desktop inherited.
* @param shell - Variables printed by the login shell.
* @returns A new environment; neither argument is modified.
*/
function mergeLoginShellEnvironment(base, shell) {
	const merged = { ...base };
	for (const [key, value] of Object.entries(shell)) {
		if (SHELL_SESSION_KEYS.has(key) || LAUNCHER_OWNED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
		merged[key] = value;
	}
	return merged;
}
function readShell(shell, base, cwd, timeoutMs, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted === true) {
			resolve("aborted");
			return;
		}
		let child;
		try {
			child = spawn(shell, ["-ilc", DUMP], {
				cwd,
				env: {
					...base,
					...PROBE_ENVIRONMENT
				},
				stdio: [
					"ignore",
					"pipe",
					"ignore"
				],
				detached: true
			});
		} catch (error) {
			resolve(String(error));
			return;
		}
		const chunks = [];
		let tail = Buffer.alloc(0);
		let markers = 0;
		const output = () => parseLoginShellOutput(Buffer.concat(chunks).toString("utf8")) ?? "unparsed";
		const onData = (chunk) => {
			chunks.push(chunk);
			const window = Buffer.concat([tail, chunk]);
			for (let index = window.indexOf(MARKER); index !== -1; index = window.indexOf(MARKER, index + MARKER.length)) markers++;
			tail = window.subarray(Math.max(0, window.length - MARKER.length + 1));
			if (markers >= 2) finish(output());
		};
		const killGroup = () => {
			const group = -child.pid;
			try {
				process.kill(group, "SIGKILL");
			} catch (_error) {}
		};
		const stop = (reason) => {
			finish(reason);
			killGroup();
		};
		const onAbort = () => {
			stop("aborted");
		};
		const timer = setTimeout(() => {
			stop("timeout");
		}, timeoutMs);
		function finish(result) {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			child.stdout.off("data", onData);
			child.stdout.resume();
			resolve(result);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", onData);
		child.on("error", (error) => {
			finish(error.message);
		});
		child.on("close", (code, closeSignal) => {
			if (code !== 0) {
				finish(closeSignal ?? `exit ${String(code)}`);
				return;
			}
			finish(output());
		});
	});
}
/**
* Read the user's login-shell environment once; Windows GUI launches already inherit the registry
* environment, so `win32` returns `base` unchanged. Never rejects: each failing candidate is
* recorded and the next one tried, and `base` is returned when all fail or the read is aborted.
* @param base - Environment Desktop inherited.
* @param config - Validated read settings.
* @param options - Platform, candidates, and cancellation.
* @returns Host environment and the candidate failures that preceded it.
*/
async function readDesktopLoginShellEnvironment(base, config, options = {}) {
	const { platform = process.platform, shells = loginShellCandidates(), signal } = options;
	if (platform === "win32") return {
		environment: base,
		failures: []
	};
	const failures = [];
	for (const shell of shells) {
		const result = await readShell(shell, base, homedir(), config.timeoutMs, signal);
		if (typeof result !== "string") return {
			environment: mergeLoginShellEnvironment(base, result),
			failures
		};
		failures.push({
			shell,
			reason: result
		});
		if (result === "aborted") break;
	}
	return {
		environment: base,
		failures
	};
}
//#endregion
//#region lib/types/mandatory-update-policy.js
/** Mandatory-update policy, independent of local business traffic and updater artifacts. */
function record$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function origin(value, local) {
	if (typeof value !== "string") throw new Error("desktop policy: origin must be a URL");
	const url = new URL(value);
	if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.protocol !== "https:" && !(local && url.protocol === "http:" && url.hostname === "127.0.0.1")) throw new Error("desktop policy: expected an HTTPS origin without credentials, path, query, or fragment");
	return url.origin;
}
/**
* Resolve deployment JSON without guessing a production service or download destination.
* @param input - Parsed configuration with origin and allowedPageOrigins; absent configuration disables policy queries.
* @param allowLoopback - Explicit unpackaged/test permission for an HTTP 127.0.0.1 policy origin only.
* @returns Validated polling options, or undefined when unconfigured.
*/
function resolveDesktopPolicyConfig(input, allowLoopback = false) {
	if (input === void 0) return void 0;
	const value = record$1(input);
	if (value === void 0 || !Array.isArray(value.allowedPageOrigins) || value.allowedPageOrigins.length === 0) throw new Error("desktop policy: configure origin and a nonempty allowedPageOrigins list");
	const fields = value;
	function duration(key, fallback) {
		const duration = fields[key] ?? fallback;
		if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 1e3 || duration > 2147483647) throw new Error(`desktop policy: ${key} must be an integer from 1000 through 2147483647`);
		return duration;
	}
	const intervalMs = duration("intervalMs", 6e5);
	const maxBackoffMs = duration("maxBackoffMs", 36e5);
	const jitter = value.jitter ?? .2;
	const authentication = value.authentication ?? "anonymous";
	if (authentication !== "anonymous" && authentication !== "feishu-test") throw new Error("desktop policy: authentication must be anonymous or feishu-test");
	const authOrigins = value.allowedAuthOrigins;
	if (authentication === "feishu-test" && (!Array.isArray(authOrigins) || authOrigins.length === 0)) throw new Error("desktop policy: test authentication requires nonempty allowedAuthOrigins");
	if (authentication === "anonymous" && authOrigins !== void 0) throw new Error("desktop policy: anonymous policy must not configure allowedAuthOrigins");
	if (typeof jitter !== "number" || !Number.isFinite(jitter) || jitter < 0 || jitter > 1 || maxBackoffMs < intervalMs) throw new Error("desktop policy: jitter must be in [0, 1] and maxBackoffMs must cover intervalMs");
	return {
		origin: origin(value.origin, authentication === "anonymous" && allowLoopback),
		allowedPageOrigins: value.allowedPageOrigins.map((item) => origin(item, false)),
		allowedAuthOrigins: authentication === "feishu-test" ? authOrigins.map((item) => origin(item, false)) : [],
		intervalMs,
		timeoutMs: duration("timeoutMs", 15e3),
		maxBackoffMs,
		jitter,
		authentication
	};
}
/**
* Validate the fallback page immediately before browser or clipboard use.
* @param value - Policy-provided page, never an updater feed or shell command.
* @param allowedOrigins - Exact HTTPS origins from deployment configuration.
* @returns Normalized allowed URL, or undefined for a missing/disallowed destination.
*/
function desktopPolicyPage(value, allowedOrigins) {
	if (typeof value !== "string" || value.length > 2048) return void 0;
	let url;
	try {
		url = new URL(value);
	} catch {
		return;
	}
	return url.protocol === "https:" && url.username === "" && url.password === "" && allowedOrigins.includes(url.origin) ? url.href : void 0;
}
function text(value, limit) {
	return typeof value === "string" && value.trim() !== "" && value.length <= limit ? value : void 0;
}
function parsePolicy(body, ok, config) {
	const root = record$1(body);
	const data = record$1(root?.data);
	if (root?.code === 40005) {
		const content = record$1(data?.show_content);
		const title = text(content?.title, 256);
		const detail = text(content?.detail, 16384);
		const page = desktopPolicyPage(data?.desktop_app_link, config.allowedPageOrigins);
		return {
			blocking: true,
			checking: false,
			...title === void 0 ? {} : { title },
			...detail === void 0 ? {} : { detail },
			...page === void 0 ? {} : { page }
		};
	}
	if (ok && root?.code === 0 && data?.biz_code === 0 && data.biz_data === null) return {
		blocking: false,
		checking: false
	};
	throw new Error("desktop policy: response does not contain a valid mandatory or no-force decision");
}
/** Owns one installed-client context, its in-flight request, and polling schedule. */
var DesktopMandatoryUpdatePolicy = class {
	config;
	identity;
	publish;
	request;
	client;
	random;
	current = {
		blocking: false,
		checking: false
	};
	pending;
	pendingChannel;
	controller;
	timer;
	disposed = false;
	failures = 0;
	nextCheck = -Infinity;
	/**
	* @param config - Resolved deployment settings.
	* @param identity - Installed software identity; a channel getter may follow an explicit user selection.
	* @param publish - Receives policy changes without controlling downloads or existing tasks.
	* @param request - Anonymous Fetch or the dedicated test-authentication Session transport.
	* @param client - UI build version, language, and UTC offset, sampled for every check.
	* @param random - Jitter source, replaceable for clock-driven tests.
	*/
	constructor(config, identity, publish, request = fetch, client, random = Math.random) {
		this.config = config;
		this.identity = identity;
		this.publish = publish;
		this.request = request;
		this.client = client;
		this.random = random;
		if (valid(this.client().version) === null || valid(identity.bundledDshVersion) === null || identity.platform === "win32" && identity.arch !== "x64") throw new Error("desktop policy: invalid installed client identity");
	}
	/** Platform headers for one check; the calling UI's language and UTC offset are read now. */
	requestHeaders(channel) {
		return {
			...platformClientHeaders(this.identity.platform, this.client()),
			"x-client-arch": this.identity.arch,
			"x-client-update-channel": channel,
			"x-client-bundled-dsh-version": this.identity.bundledDshVersion
		};
	}
	/** Latest policy; failures never erase a known mandatory decision. */
	get state() {
		return this.current;
	}
	/**
	* Check immediately when manual, otherwise only when due; matching concurrent callers share one request.
	* @param scenario - Trigger recorded in the query, independent of backend matching.
	* @param manual - Bypass interval/backoff without bypassing request coalescing.
	* @returns Current decision or retained decision with an error; disposed instances reject.
	*/
	check(scenario, manual = false) {
		if (this.disposed) return Promise.reject(/* @__PURE__ */ new Error("desktop policy: disposed"));
		if (this.pending !== void 0) return this.pendingChannel === this.identity.channel ? this.pending : this.pending.then(() => this.check(scenario, true));
		if (!manual && Date.now() < this.nextCheck) return Promise.resolve(this.current);
		clearTimeout(this.timer);
		const channel = this.identity.channel;
		this.pendingChannel = channel;
		this.pending = Promise.resolve().then(async () => {
			if (this.disposed) return this.current;
			const controller = new AbortController();
			this.controller = controller;
			const timeout = setTimeout(() => {
				controller.abort();
			}, this.config.timeoutMs);
			this.setState({
				...this.current,
				checking: true
			});
			try {
				const url = new URL("/api/v0/check_client_update", this.config.origin);
				url.searchParams.set("scenario", scenario);
				const response = await this.request(url, {
					headers: this.requestHeaders(channel),
					signal: controller.signal,
					credentials: this.config.authentication === "feishu-test" ? "include" : "omit",
					cache: "no-store",
					redirect: "error"
				});
				const body = await response.json();
				if (this.config.authentication === "feishu-test" && response.status === 401 && record$1(record$1(body)?.error)?.code === "UNAUTHENTICATED") {
					this.failures++;
					this.setState({
						...this.current,
						checking: false,
						error: "authentication-required"
					});
					return this.current;
				}
				const state = parsePolicy(body, response.ok, this.config);
				this.failures = 0;
				this.setState(state);
			} catch {
				this.failures++;
				this.setState({
					...this.current,
					checking: false,
					error: "unavailable"
				});
			} finally {
				clearTimeout(timeout);
				this.controller = void 0;
			}
			return this.current;
		}).finally(() => {
			this.pending = void 0;
			if (this.disposed) return;
			const base = Math.min(this.config.maxBackoffMs, this.config.intervalMs * 2 ** Math.min(this.failures, 20));
			const delay = Math.min(this.config.maxBackoffMs, Math.round(base * (1 + this.random() * this.config.jitter)));
			this.nextCheck = Date.now() + delay;
			this.timer = setTimeout(() => {
				this.check("periodic");
			}, delay);
		});
		return this.pending;
	}
	/** Abort the owned request and await settlement; late responses cannot publish or schedule work. */
	async dispose() {
		this.disposed = true;
		clearTimeout(this.timer);
		this.controller?.abort();
		await this.pending;
	}
	setState(state) {
		if (this.disposed) return;
		this.current = state;
		this.publish(state);
	}
};
//#endregion
//#region lib/types/mandatory-update-ipc.js
/** Dependency-free IPC names shared with the sandboxed mandatory-update preload. */
const MANDATORY_IPC = {
	status: "dsh-desktop:mandatory-status",
	state: "dsh-desktop:mandatory-state",
	action: "dsh-desktop:mandatory-action"
};
//#endregion
//#region lib/types/update-attention.js
/** Best-effort background attention never grants update or task-stop authorization. */
/** Owns one reminder per downloaded version until reset for a new download. */
var DesktopUpdateAttention = class {
	locale;
	platform;
	version;
	notification;
	stop;
	/**
	* @param locale - Shell-owned notification copy.
	* @param platform - Native attention implementation, replaceable for platform tests.
	*/
	constructor(locale, platform = process.platform) {
		this.locale = locale;
		this.platform = platform;
	}
	/**
	* @param version - Prepared target whose confirmation is waiting.
	* @param parent - Taskbar window; never restored or focused by the reminder.
	* @param modal - Existing installation confirmation.
	* @param returnToConfirmation - Rechecks current policy and returns to UI without installing.
	*/
	ready(version, parent, modal, returnToConfirmation) {
		if (this.version === version) return;
		this.version = version;
		if (parent.isFocused() || modal.isFocused()) return;
		const clear = () => {
			this.clear();
		};
		let bounce;
		parent.on("focus", clear);
		modal.on("focus", clear);
		this.stop = () => {
			parent.off("focus", clear);
			modal.off("focus", clear);
			if (this.platform === "win32" && !parent.isDestroyed()) parent.flashFrame(false);
			if (bounce !== void 0) app.dock?.cancelBounce(bounce);
		};
		try {
			if (this.platform === "win32") parent.flashFrame(true);
			if (this.platform === "darwin") bounce = app.dock?.bounce("informational");
		} catch (error) {
			console.warn("desktop update: attention unavailable", error);
		}
		try {
			if (!Notification.isSupported()) return;
			const notification = new Notification({
				title: this.locale.messages.mandatoryReady,
				body: this.locale.messages.mandatoryNotification,
				silent: true
			});
			this.notification = notification;
			notification.on("failed", () => {
				if (this.notification === notification) this.notification = void 0;
				notification.removeAllListeners();
			});
			notification.once("click", () => {
				if (this.notification !== notification) return;
				this.clear();
				returnToConfirmation();
			});
			notification.show();
		} catch (error) {
			console.warn("desktop update: notification unavailable", error);
		}
	}
	/** Release owned native reminders without scheduling another for the same target. */
	clear() {
		const notification = this.notification;
		this.notification = void 0;
		notification?.removeAllListeners();
		try {
			notification?.close();
		} catch (error) {
			console.warn("desktop update: could not close notification", error);
		}
		const stop = this.stop;
		this.stop = void 0;
		try {
			stop?.();
		} catch (error) {
			console.warn("desktop update: could not clear attention", error);
		}
	}
	/** Start a new download episode, or dispose all owned reminders. */
	reset() {
		this.clear();
		this.version = void 0;
	}
};
//#endregion
//#region lib/types/mandatory-update-window.js
/** Shell-owned modal policy UI; only explicit actions authorize downloads or browser navigation. */
const page$1 = "dsh-app://shell/mandatory-update.html";
/** Shell-owned update presentation inside the native owner; policy and installation approval remain main-owned. */
var DesktopMandatoryUpdateWindow = class {
	options;
	embedded = process.platform === "win32";
	embeddedParent;
	embeddedBlocking = false;
	publishEmbedded = () => {
		this.embeddedBlocking = false;
		this.sync();
	};
	window;
	surfaceParent;
	recovery;
	closing;
	disposed = false;
	error;
	action;
	confirmation;
	confirmationRevision = 0;
	deferred = false;
	restart;
	navigation;
	navigationUrl;
	navigationEpoch = 0;
	attention;
	/** @param options - Main-process actions and immutable deployment/navigation settings. */
	constructor(options) {
		this.options = options;
		this.attention = new DesktopUpdateAttention(options.locale);
		this.embeddedParent = this.embedded ? options.parent() : void 0;
		this.embeddedParent?.webContents.on("did-finish-load", this.publishEmbedded);
		ipcMain.handle(MANDATORY_IPC.status, (event) => {
			this.assertSender(event);
			return this.view();
		});
		ipcMain.handle(MANDATORY_IPC.action, (event, action, version, confirmationRevision) => {
			this.assertSender(event);
			if (!this.options.policy().blocking) throw new Error("desktop policy: no mandatory decision is active");
			if (typeof action !== "string" || ![
				"refresh",
				"download",
				"install",
				"later",
				"page",
				"copy"
			].includes(action)) throw new Error("desktop policy: invalid action");
			if ([
				"download",
				"install",
				"later"
			].includes(action) && typeof version !== "string") throw new Error("desktop policy: missing confirmed version");
			if (action === "page" || action === "copy") return this.navigate(action);
			if (this.confirmation !== void 0 && (action === "install" || action === "later")) {
				if (version !== this.confirmation.version || confirmationRevision !== this.confirmation.revision) throw new Error("desktop policy: stale installation confirmation");
				if (action === "later" && !this.confirmation.active) throw new Error("desktop policy: no task deferral is offered");
				this.deferred = action === "later";
				this.finishConfirmation(action === "install");
				this.sync();
				return Promise.resolve();
			}
			if (action === "later") throw new Error("desktop policy: no installation confirmation");
			this.action ??= Promise.resolve().then(async () => {
				this.error = void 0;
				this.restart = void 0;
				this.deferred = false;
				this.clearNavigation();
				if (action === "download") this.attention.reset();
				this.sync();
				switch (action) {
					case "refresh":
						await this.options.refresh();
						break;
					case "download":
						await this.options.download(version);
						break;
					case "install":
						await this.options.install(version);
						break;
				}
			}).catch(() => {
				this.error = this.options.locale.messages.mandatoryActionFailed;
			}).finally(() => {
				this.action = void 0;
				this.sync();
			});
			return this.action;
		});
	}
	/** Active modal used as the owner of shell installation-confirmation dialogs. */
	get confirmationWindow() {
		return this.embedded ? this.options.parent() : this.surfaceParent;
	}
	/**
	* @param version - Updater-owned target, already downloaded and verified.
	* @param active - Fresh Host task inspection; unknown state must fail before calling.
	* @returns Explicit approval from this same modal, or false on deferral, policy clearance, or disposal.
	*/
	confirm(version, active) {
		if (this.disposed || !this.options.policy().blocking) return Promise.resolve(false);
		this.finishConfirmation(false);
		this.deferred = false;
		this.restart = void 0;
		return new Promise((resolve) => {
			this.confirmation = {
				version,
				active,
				revision: ++this.confirmationRevision,
				resolve
			};
			this.sync();
			const parent = this.options.parent();
			const owner = this.confirmationWindow;
			if (parent !== void 0 && owner !== void 0) this.attention.ready(version, parent, owner, () => {
				if (!this.disposed && this.options.policy().blocking && this.confirmation !== void 0) this.focus();
			});
			else this.finishConfirmation(false);
		});
	}
	/** @param active - Whether admitted tasks are actually being stopped after installation approval. */
	preparingRestart(active) {
		this.restart = active ? "stopping-tasks" : "preparing";
		this.attention.clear();
		this.sync();
	}
	/** Publish current status, create the block immediately, or close it only after policy clearance. */
	sync() {
		if (this.disposed) return;
		if (!this.embedded && this.window !== void 0 && this.surfaceParent !== this.options.parent()) {
			this.recovery?.dispose();
			this.recovery = void 0;
			this.finishConfirmation(false);
			const previous = this.window;
			this.window = void 0;
			this.surfaceParent = void 0;
			previous.destroy();
		}
		if (this.embedded) {
			const parent = this.options.parent();
			if (parent !== this.embeddedParent) {
				if (this.embeddedParent !== void 0 && !this.embeddedParent.isDestroyed()) this.embeddedParent.webContents.off("did-finish-load", this.publishEmbedded);
				this.embeddedBlocking = false;
				this.embeddedParent = parent;
				if (parent !== void 0 && !parent.isDestroyed()) parent.webContents.on("did-finish-load", this.publishEmbedded);
			}
			if (parent === void 0 || parent.isDestroyed()) return;
		}
		if (!this.options.policy().blocking) {
			this.recovery?.dismiss();
			this.finishConfirmation(false);
			this.attention.reset();
			this.clearNavigation();
			this.restart = void 0;
			this.deferred = false;
			if (this.window !== void 0 && this.closing === void 0) {
				const window = this.window;
				window.webContents.send(MANDATORY_IPC.state, this.view());
				this.closing = setTimeout(() => {
					this.closing = void 0;
					if (this.window === window) {
						this.window = void 0;
						this.surfaceParent = void 0;
					}
					window.destroy();
				}, 150);
			}
			this.error = void 0;
			if (this.embedded && this.embeddedBlocking) {
				this.embeddedBlocking = false;
				this.embeddedParent?.webContents.send(MANDATORY_IPC.state, this.view());
			}
			return;
		}
		clearTimeout(this.closing);
		this.closing = void 0;
		if (this.navigationUrl !== this.options.policy().page) this.clearNavigation();
		if (this.options.update().phase === "error") this.restart = void 0;
		if (this.embedded) {
			this.embeddedBlocking = true;
			this.embeddedParent?.webContents.send(MANDATORY_IPC.state, this.view());
			return;
		}
		if (this.window === void 0) {
			const parent = this.options.parent();
			if (parent === void 0 || parent.isDestroyed()) return;
			const window = this.options.overlays.create(parent, this.options.preload);
			this.window = window;
			this.surfaceParent = parent;
			window.webContents.once("destroyed", () => {
				if (this.window === window) {
					this.window = void 0;
					this.surfaceParent = void 0;
					this.finishConfirmation(false);
					if (!this.disposed) queueMicrotask(() => {
						this.sync();
					});
				}
			});
			window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
			window.webContents.on("will-navigate", (event, url) => {
				if (url !== page$1) event.preventDefault();
			});
			window.webContents.on("will-redirect", (event) => {
				event.preventDefault();
			});
			const recovery = this.attachRecovery(window, parent);
			this.recovery = recovery;
			recovery.load();
		}
		this.window.webContents.send(MANDATORY_IPC.state, this.view());
	}
	/** Focus the block instead of opening ordinary product or plugin interactions. */
	focus() {
		this.sync();
		const parent = this.options.parent();
		if (parent?.isDestroyed()) return;
		if (parent?.isMinimized()) parent.restore();
		parent?.show();
		parent?.focus();
		this.window?.focus();
	}
	/** Detach IPC and release the modal during shutdown, including after the main window closes. */
	dispose() {
		this.disposed = true;
		this.recovery?.dispose();
		this.recovery = void 0;
		clearTimeout(this.closing);
		this.closing = void 0;
		this.finishConfirmation(false);
		this.attention.reset();
		this.clearNavigation();
		ipcMain.removeHandler(MANDATORY_IPC.status);
		ipcMain.removeHandler(MANDATORY_IPC.action);
		if (this.embeddedParent !== void 0 && !this.embeddedParent.isDestroyed()) {
			this.embeddedParent.webContents.off("did-finish-load", this.publishEmbedded);
			this.embeddedParent.webContents.send(MANDATORY_IPC.state, {
				...this.view(),
				policy: {
					blocking: false,
					checking: false
				}
			});
		}
		this.window?.destroy();
		this.window = void 0;
		this.surfaceParent = void 0;
	}
	attachRecovery(surface, parent) {
		let released = false;
		let failed = false;
		let attempt = 0;
		let prompt;
		const valid = () => !released && !this.disposed && this.options.policy().blocking && this.options.parent() === parent && this.window === surface && !surface.isDestroyed() && !parent.isDestroyed();
		const dismiss = () => {
			prompt?.abort();
		};
		const show = () => {
			if (!valid() || !failed || prompt !== void 0 || !parent.isVisible() || !parent.isFocused()) return;
			const controller = new AbortController();
			prompt = controller;
			const messages = this.options.locale.messages;
			const policy = this.options.policy();
			const update = this.options.update();
			const destination = desktopPolicyPage(policy.page, this.options.allowedPageOrigins);
			const actions = destination === void 0 ? ["quit"] : ["page", "quit"];
			const labels = {
				page: messages.mandatoryViewDownload,
				quit: messages.quit
			};
			const detail = [
				policy.detail ?? messages.mandatoryDetail,
				..."version" in update ? [messages.mandatoryVersion.replace("{version}", update.version)] : [],
				...this.navigation?.page === "failed" ? [messages.mandatoryViewPageFailed] : []
			].join("\n\n");
			dialog.showMessageBox(parent, {
				type: "error",
				title: messages.mandatoryTitle,
				message: policy.title ?? messages.mandatoryTitle,
				detail,
				buttons: actions.map((action) => labels[action]),
				defaultId: 0,
				cancelId: -1,
				noLink: true,
				signal: controller.signal
			}).then(({ response }) => {
				if (prompt === controller) prompt = void 0;
				if (controller.signal.aborted) {
					show();
					return;
				}
				if (!valid() || !failed) return;
				if (actions[response] === "quit") app.quit();
				else if (actions[response] === "page") {
					if (destination !== desktopPolicyPage(this.options.policy().page, this.options.allowedPageOrigins)) {
						show();
						return;
					}
					this.navigate("page").then(() => {
						if (this.navigation?.page === "failed") show();
					}).catch((error) => {
						console.error("desktop policy: recovery download page failed", error);
					});
				} else show();
			}).catch((error) => {
				if (prompt === controller) prompt = void 0;
				console.error("desktop policy: native update recovery failed", error);
			});
		};
		const load = async () => {
			if (!valid()) return;
			const revision = ++attempt;
			failed = false;
			dismiss();
			try {
				await surface.loadURL(page$1);
			} catch (error) {
				if (!valid() || revision !== attempt) return;
				console.error("desktop policy: mandatory update view failed to load", error);
				failed = true;
				show();
				return;
			}
			if (!valid() || revision !== attempt) return;
			failed = false;
			dismiss();
			this.sync();
		};
		const loaded = () => {
			if (!valid()) return;
			failed = false;
			dismiss();
		};
		const crashed = () => {
			load();
		};
		const dispose = () => {
			if (released) return;
			released = true;
			dismiss();
			parent.off("focus", show);
			parent.off("hide", dismiss);
			surface.webContents.off("did-finish-load", loaded);
			surface.webContents.off("render-process-gone", crashed);
			surface.webContents.off("destroyed", dispose);
		};
		parent.on("focus", show);
		parent.on("hide", dismiss);
		surface.webContents.on("did-finish-load", loaded);
		surface.webContents.on("render-process-gone", crashed);
		surface.webContents.once("destroyed", dispose);
		return {
			load,
			dismiss,
			dispose
		};
	}
	view() {
		return {
			locale: process.platform === "win32" ? {
				...this.options.locale,
				messages: {
					...this.options.locale.messages,
					mandatoryReadyDetail: this.options.locale.messages.updateDownloadedDetailWindows
				}
			} : this.options.locale,
			policy: this.options.policy(),
			update: this.options.update(),
			deferred: this.deferred,
			...this.confirmation === void 0 ? {} : { confirmation: {
				version: this.confirmation.version,
				active: this.confirmation.active,
				revision: this.confirmation.revision
			} },
			...this.restart === void 0 ? {} : { restart: this.restart },
			...this.navigation === void 0 ? {} : { navigation: this.navigation },
			...this.error === void 0 ? {} : { error: this.error }
		};
	}
	finishConfirmation(approved) {
		const confirmation = this.confirmation;
		this.confirmation = void 0;
		this.attention.clear();
		confirmation?.resolve(approved);
	}
	clearNavigation() {
		this.navigation = void 0;
		this.navigationUrl = void 0;
		this.navigationEpoch++;
	}
	async navigate(action) {
		const url = desktopPolicyPage(this.options.policy().page, this.options.allowedPageOrigins);
		if (url === void 0) throw new Error("desktop policy: no allowed download page");
		if (this.navigationUrl !== url) this.clearNavigation();
		this.navigationUrl = url;
		if (action === "page") {
			this.navigation = { page: "requested" };
			this.navigationEpoch++;
		}
		const epoch = this.navigationEpoch;
		this.sync();
		try {
			if (action === "copy") {
				await clipboard.writeText(url);
				if (await clipboard.readText() !== url) throw new Error("desktop policy: clipboard did not retain download address");
			} else await shell.openExternal(url);
			if (epoch !== this.navigationEpoch || this.disposed) return;
			if (action === "copy") this.navigation = {
				page: this.navigation?.page ?? "requested",
				copy: "copied"
			};
		} catch {
			if (epoch !== this.navigationEpoch || this.disposed) return;
			this.navigation = action === "page" ? {
				...this.navigation,
				page: "failed"
			} : {
				page: this.navigation?.page ?? "requested",
				copy: "failed"
			};
		}
		this.sync();
	}
	assertSender(event) {
		if (this.embedded) {
			const parent = this.options.parent();
			if (parent === void 0 || parent.isDestroyed() || event.sender !== parent.webContents || event.senderFrame !== parent.webContents.mainFrame) throw new Error("desktop policy: rejected unowned renderer");
			assertDesktopSender(event, ["app"]);
			return;
		}
		if (event.sender !== this.window?.webContents || event.senderFrame !== this.window.webContents.mainFrame || event.senderFrame.url !== page$1) throw new Error("desktop policy: rejected unowned renderer");
	}
};
//#endregion
//#region lib/types/policy-test-auth.js
/** Isolated, process-lifetime Feishu cookies for explicitly configured test policy requests. */
/** Packaged placeholder document; it is the window's first document and needs no network. */
const LOGIN_LOADING_PAGE = "renderer/policy-login-loading.html";
/** File name of that placeholder, for recognizing its own load and load failures. */
const LOGIN_LOADING_FILE = "policy-login-loading.html";
/** Owns the login window and its nonpersistent Session; no product window shares its cookies or privileges. */
var DesktopPolicyTestAuth = class {
	origin;
	allowedAuthOrigins;
	locale;
	parent;
	record;
	browserSession = session.fromPartition(`dsh-policy-auth-${randomUUID()}`, { cache: false });
	window;
	pending;
	disposed = false;
	rejectLogin;
	/** Return to an existing login window without starting another authentication flow. */
	focus() {
		this.window?.show();
		this.window?.focus();
	}
	/**
	* @param origin Validated HTTPS policy origin; login always starts at its root with fresh gateway state.
	* @param allowedAuthOrigins Validated HTTPS origins for login document navigation.
	* @param locale Shell-owned login title.
	* @param parent Current application or mandatory-update window.
	* @param record Fixed, nonsecret login outcomes for diagnostic evidence.
	*/
	constructor(origin, allowedAuthOrigins, locale, parent, record) {
		this.origin = origin;
		this.allowedAuthOrigins = allowedAuthOrigins;
		this.locale = locale;
		this.parent = parent;
		this.record = record;
		this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
			callback(false);
		});
		this.browserSession.setPermissionCheckHandler(() => false);
		this.browserSession.setDevicePermissionHandler(() => false);
		this.browserSession.on("will-download", (event) => {
			event.preventDefault();
		});
		this.browserSession.webRequest.onBeforeRequest((details, callback) => {
			const cancel = (details.resourceType === "mainFrame" || details.resourceType === "subFrame") && !this.isLoadingDocument(details.url) && !this.allowed(details.url);
			callback({ cancel });
			if (cancel) this.rejectLogin?.();
		});
	}
	/**
	* Send only the configured policy request through the login Session; redirects remain forbidden.
	* @param input Policy URL supplied by the main-process coordinator.
	* @param init Request headers, credentials, and cancellation owned by that coordinator.
	* @returns Chromium response without exposing cookies to JavaScript.
	*/
	request = (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (this.disposed || url.origin !== this.origin || url.pathname !== "/api/v0/check_client_update" || url.username !== "" || url.password !== "") return Promise.reject(/* @__PURE__ */ new Error("desktop policy: disallowed authenticated request"));
		return this.browserSession.fetch(url.href, {
			...init,
			credentials: "include",
			redirect: "error",
			cache: "no-store"
		});
	};
	/**
	* Open only after a user action; repeated callers focus and join the same login.
	* @returns Navigation, cancellation, or failure; the caller must query policy after returning.
	*/
	login() {
		if (this.disposed) return Promise.resolve("cancelled");
		if (this.pending !== void 0) {
			this.focus();
			return this.pending;
		}
		const result = Promise.withResolvers();
		const parent = this.parent();
		const window = new BrowserWindow({
			width: 720,
			height: 760,
			...parent === void 0 ? {} : { parent },
			title: this.locale.messages.policyLoginTitle,
			autoHideMenuBar: true,
			webPreferences: {
				session: this.browserSession,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				webSecurity: true,
				webviewTag: false,
				devTools: true,
				spellcheck: false
			}
		});
		this.pending = result.promise;
		this.window = window;
		let settled = false;
		const finish = (outcome) => {
			if (settled) return;
			settled = true;
			this.window = void 0;
			this.pending = void 0;
			this.rejectLogin = void 0;
			if (!window.isDestroyed()) window.destroy();
			result.resolve(outcome);
			this.record(outcome);
		};
		this.rejectLogin = () => {
			finish("failed");
		};
		window.setMenu(null);
		window.on("closed", () => {
			finish("cancelled");
		});
		window.on("page-title-updated", (event) => {
			event.preventDefault();
		});
		const contents = window.webContents;
		contents.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown" || input.key !== "F12" || input.isAutoRepeat) return;
			event.preventDefault();
			contents.openDevTools({ mode: "detach" });
		});
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
		contents.on("will-navigate", (event, url) => {
			if (!this.allowed(url)) {
				event.preventDefault();
				finish("failed");
			}
		});
		contents.on("will-redirect", (event, url) => {
			if (!this.allowed(url)) {
				event.preventDefault();
				finish("failed");
			}
		});
		contents.on("will-attach-webview", (event) => {
			event.preventDefault();
		});
		contents.on("login", (event, _details, _authInfo, callback) => {
			event.preventDefault();
			callback();
		});
		contents.on("did-fail-load", (_event, code, _description, url, mainFrame) => {
			if (mainFrame && code !== -3 && !this.isLoadingDocument(url)) finish("failed");
		});
		contents.on("render-process-gone", () => {
			finish("failed");
		});
		contents.on("did-navigate", (_event, value) => {
			const url = new URL(value);
			if (url.origin === this.origin && (url.pathname === "/" || url.pathname === "/feishu_auth_callback")) finish("returned");
		});
		this.record("opened");
		const loadLogin = () => {
			if (settled || window.isDestroyed()) return;
			window.loadURL(`${this.origin}/`).catch(() => {
				finish("failed");
			});
		};
		window.loadFile(LOGIN_LOADING_PAGE, { query: { label: this.locale.messages.policyLoginLoading } }).then(loadLogin, loadLogin);
		return result.promise;
	}
	/** Close the login and erase session data after the policy coordinator has stopped its requests. */
	async dispose() {
		this.disposed = true;
		this.window?.destroy();
		await this.pending;
		await this.browserSession.closeAllConnections();
		await this.browserSession.clearStorageData();
		await this.browserSession.clearAuthCache();
	}
	allowed(value) {
		let url;
		try {
			url = new URL(value);
		} catch {
			return false;
		}
		return url.protocol === "https:" && url.username === "" && url.password === "" && (url.origin === this.origin || this.allowedAuthOrigins.includes(url.origin));
	}
	/**
	* Recognize the owned placeholder document. Only the request filter and the
	* load-failure handler accept it; navigation events still require {@link allowed},
	* so the remote page cannot steer the window back to a local file.
	*/
	isLoadingDocument(value) {
		let url;
		try {
			url = new URL(value);
		} catch {
			return false;
		}
		return url.protocol === "file:" && url.pathname.endsWith(`/${LOGIN_LOADING_FILE}`);
	}
};
//#endregion
//#region lib/types/settings.js
/** Startup policy for optional Electron shell preferences, independent of the Host. */
/**
* Initialize the shared document explicitly at startup, then resolve the popup preference.
* @param userData - Electron userData, independent of DSH_HOME.
* @returns Validated popup preference, or false with a diagnostic on failure; changes require restart.
*/
async function readDesktopSettings(userData) {
	const file = new DesktopSettingsFile(userData);
	const result = await file.initialize();
	const preference = result.kind === "ready" ? result.fields.allowTestAuthPopupWindow : void 0;
	if (preference?.kind === "valid") return { updates: { allowTestAuthPopupWindow: preference.value } };
	const error = result.kind === "error" ? result.error : preference?.kind === "invalid" ? preference.error : void 0;
	if (error) try {
		console.warn(`desktop settings: ${file.path}: using defaults because settings could not be loaded`, error);
	} catch (_logError) {}
	return { updates: { allowTestAuthPopupWindow: false } };
}
//#endregion
//#region lib/types/locale-cache.js
/** Last confirmed shell language, available even when the Host cannot start. */
/**
* Read the last confirmed language without requiring Host settings.
* @param userData - Electron userData directory.
* @returns Cached language, or undefined when missing, invalid or unreadable.
*/
function readDesktopLocaleCache(userData) {
	try {
		const value = readFileSync(join(userData, "desktop", "locale-cache"), "utf8").trim();
		const locale = resolveDesktopLocale(value);
		if (locale.id === value) return locale.id;
		throw new Error("expected a canonical Desktop locale id");
	} catch (error) {
		if (error.code !== "ENOENT") console.warn("desktop locale cache: using system language because the cache could not be read", error);
		return;
	}
}
/**
* Remember a confirmed language; write failure leaves the active language unchanged.
* @param userData - Electron userData directory.
* @param locale - Language confirmed by Host settings or the owned renderer.
*/
function writeDesktopLocaleCache(userData, locale) {
	try {
		const directory = join(userData, "desktop");
		mkdirSync(directory, {
			recursive: true,
			mode: 448
		});
		writeFileSync(join(directory, "locale-cache"), `${locale}\n`, { mode: 384 });
	} catch (error) {
		console.warn("desktop locale cache: language could not be saved for the next startup", error);
	}
}
//#endregion
//#region lib/types/update-dialog.js
/** Main-owned update confirmations; closing or replacing a dialog never grants installation permission. */
/** Channels available only to the isolated update-dialog document. */
const UPDATE_DIALOG_IPC = {
	status: "dsh-update-dialog:status",
	changed: "dsh-update-dialog:changed",
	respond: "dsh-update-dialog:respond"
};
const page = "dsh-app://shell/update-dialog.html";
/** One fading backdrop with replaceable confirmation content; aborted checks and mandatory policy cancel ordinary prompts. */
var DesktopUpdateDialog = class {
	preload;
	locale;
	overlays;
	disposed = false;
	revision = 0;
	view;
	parent;
	closing;
	active;
	/** Focus the current explanation or confirmation without replacing it or granting permission. */
	focus() {
		if (this.active === void 0 || this.parent?.isDestroyed() !== false) return;
		this.parent.focus();
		this.view?.webContents.focus();
	}
	/** Whether a shell prompt is awaiting a response. */
	get isOpen() {
		return this.active !== void 0;
	}
	/**
	* @param preload - Bundled isolated preload.
	* @param locale - Shell-owned copy or a reader of the current UI language.
	* @param overlays - Application-owned view creation and input tracking.
	*/
	constructor(preload, locale, overlays) {
		this.preload = preload;
		this.locale = locale;
		this.overlays = overlays;
		ipcMain.handle(UPDATE_DIALOG_IPC.status, (event) => {
			this.owned(event);
			return this.active?.view ?? null;
		});
		ipcMain.handle(UPDATE_DIALOG_IPC.respond, (event, revision, index) => {
			this.owned(event);
			const active = this.active;
			if (active === void 0 || revision !== active.view.revision) throw new Error("desktop update: stale dialog response");
			if (typeof index !== "number" || !Number.isInteger(index) || index !== active.view.cancelId && (index < 0 || index >= active.view.buttons.length)) throw new Error("desktop update: invalid dialog response");
			if (active.view.busyButton !== void 0) return;
			return active.respond(index);
		});
	}
	/**
	* @param parent - Window blocked by this confirmation.
	* @param options - Main-owned localized content, response choices, and optional cancellation signal.
	* @returns A displayed response, or cancellation on replacement, abort, close, or load failure; backdrop dismissal fades independently.
	*/
	show(parent, options) {
		const locale = typeof this.locale === "function" ? this.locale() : this.locale;
		const buttons = options.buttons ?? [locale.messages.updateAcknowledge];
		const cancelId = options.cancelId ?? buttons.length - 1;
		if (this.disposed || options.signal?.aborted === true || parent.isDestroyed()) return Promise.resolve({
			response: cancelId,
			checkboxChecked: false
		});
		if (this.parent !== parent) {
			this.cancel();
			this.close();
		}
		this.active?.finish(this.active.view.cancelId, true);
		clearTimeout(this.closing);
		this.closing = void 0;
		const existing = this.view;
		const surface = existing ?? this.overlays.create(parent, this.preload);
		this.view = surface;
		this.parent = parent;
		let view = {
			revision: ++this.revision,
			locale: locale.id,
			title: options.title ?? "",
			message: options.message,
			detail: options.detail ?? "",
			buttons,
			cancelId,
			closeLabel: locale.messages.updateClose,
			technicalDetails: options.technicalDetails ?? "",
			technicalDetailsLabel: locale.messages.updateTechnicalDetails
		};
		return new Promise((resolve) => {
			const abort = () => {
				finish(cancelId);
			};
			const finish = (response, retain = false) => {
				if (this.active?.view !== view) return;
				this.active = void 0;
				options.signal?.removeEventListener("abort", abort);
				if (!retain && !surface.webContents.isDestroyed()) {
					surface.webContents.send(UPDATE_DIALOG_IPC.changed, null);
					this.closing = setTimeout(() => {
						this.close();
					}, 150);
				}
				resolve({
					response,
					checkboxChecked: false
				});
			};
			const respond = async (index) => {
				const publish = (busy) => {
					const { busyButton: _busy, ...rest } = view;
					view = {
						...rest,
						revision: ++this.revision,
						...busy ? { busyButton: index } : {}
					};
					if (this.active !== void 0) this.active.view = view;
					surface.webContents.send(UPDATE_DIALOG_IPC.changed, view);
				};
				if (options.keepOpenAction?.index === index) {
					options.keepOpenAction.run();
					publish(false);
					return;
				}
				if (options.action?.index !== index) {
					finish(index);
					return;
				}
				publish(true);
				const held = new Promise((resolveHold) => {
					setTimeout(resolveHold, 500);
				});
				try {
					const close = await options.action.run();
					await held;
					if (this.active?.view !== view) return;
					if (close) finish(index);
					else publish(false);
				} catch (error) {
					await held;
					if (this.active?.view === view) publish(false);
					throw error;
				}
			};
			this.active = {
				view,
				finish,
				respond
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			if (existing !== void 0) {
				surface.webContents.send(UPDATE_DIALOG_IPC.changed, view);
				return;
			}
			const failed = () => {
				if (this.view === surface) {
					this.cancel();
					this.close();
				}
			};
			surface.webContents.once("destroyed", failed);
			surface.webContents.once("render-process-gone", failed);
			surface.webContents.once("preload-error", failed);
			surface.webContents.on("will-navigate", (event, url) => {
				if (url !== page) event.preventDefault();
			});
			surface.webContents.on("will-redirect", (event) => {
				event.preventDefault();
			});
			surface.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
			surface.loadURL(page).catch(failed);
		});
	}
	/** Cancel the displayed prompt without authorizing any operation. */
	cancel() {
		this.active?.finish(this.active.view.cancelId);
	}
	/** Close the document and detach its private IPC handlers. */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.cancel();
		this.close();
		ipcMain.removeHandler(UPDATE_DIALOG_IPC.status);
		ipcMain.removeHandler(UPDATE_DIALOG_IPC.respond);
	}
	close() {
		clearTimeout(this.closing);
		this.closing = void 0;
		const surface = this.view;
		this.view = void 0;
		this.parent = void 0;
		surface?.destroy();
	}
	owned(event) {
		const surface = this.view;
		if (surface === void 0 || event.sender !== surface.webContents || event.senderFrame !== surface.webContents.mainFrame || event.senderFrame.url !== page) throw new Error("desktop update: rejected unowned dialog renderer");
	}
};
//#endregion
//#region lib/types/browser-guests.js
/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
/** Owns workspace storage partitions independently from individual tab guests. */
var DesktopBrowserGuests = class {
	hostUrl;
	partitions = /* @__PURE__ */ new Map();
	leases = /* @__PURE__ */ new Map();
	/** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
	constructor(hostUrl) {
		this.hostUrl = hostUrl;
	}
	/**
	* Reserve one guest in a workspace's process-lifetime partition.
	* @param owner - authenticated primary application WebContents.
	* @param workspace - workspace identity received over IPC.
	* @returns opaque lease and the partition approved for it.
	*/
	acquire(owner, workspace) {
		if (typeof workspace !== "string" || workspace.length === 0 || workspace.length > 4096) throw new Error("desktop browser: a workspace storage identity is required");
		let partition = this.partitions.get(workspace);
		if (partition === void 0) {
			partition = `dsh-sidebar-browser-${randomUUID()}`;
			this.configureSession(session.fromPartition(partition));
			this.partitions.set(workspace, partition);
		}
		const lease = randomUUID();
		this.leases.set(lease, {
			owner,
			partition,
			attached: false
		});
		return {
			lease,
			partition
		};
	}
	/**
	* Release only a lease issued to this application window; workspace storage survives.
	* @param owner - authenticated IPC sender.
	* @param id - lease received over IPC.
	*/
	async release(owner, id) {
		if (typeof id !== "string") throw new Error("desktop browser: invalid guest lease");
		const key = id;
		const lease = this.leases.get(key);
		if (lease === void 0) return;
		if (lease.owner !== owner) throw new Error("desktop browser: guest belongs to another window");
		lease.releaseInput?.();
		this.leases.delete(key);
		const guest = lease.guest;
		if (guest !== void 0 && !guest.isDestroyed()) {
			const destroyed = new Promise((resolve) => {
				guest.once("destroyed", resolve);
			});
			guest.close({ waitForBeforeUnload: false });
			await destroyed;
		}
	}
	/**
	* Install attachment checks before the application document can create a webview.
	* @param window - primary application window.
	* @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
	*/
	bind(window, attachInput) {
		const owner = window.webContents;
		owner.on("will-attach-webview", (event, preferences, params) => {
			const id = typeof params.src === "string" && params.src.startsWith("about:blank#") ? params.src.slice(12) : "";
			const lease = this.leases.get(id);
			if (lease === void 0 || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
				event.preventDefault();
				return;
			}
			lease.attached = true;
			for (const key of Object.keys(preferences)) if (key !== "disablePopups") Reflect.deleteProperty(preferences, key);
			Object.assign(preferences, {
				partition: lease.partition,
				nodeIntegration: false,
				nodeIntegrationInWorker: false,
				nodeIntegrationInSubFrames: false,
				contextIsolation: true,
				sandbox: true,
				webSecurity: true,
				allowRunningInsecureContent: false,
				webviewTag: false,
				plugins: false,
				navigateOnDragDrop: false,
				disableDialogs: true,
				devTools: !app.isPackaged
			});
			params.httpreferrer = "";
		});
		owner.on("did-attach-webview", (_event, guest) => {
			let attachedLease;
			guest.once("dom-ready", () => {
				const url = guest.getURL();
				const id = url.startsWith("about:blank#") ? url.slice(12) : "";
				const lease = this.leases.get(id);
				if (lease === void 0 || lease.owner !== owner || lease.guest !== void 0) {
					guest.close({ waitForBeforeUnload: false });
					return;
				}
				lease.guest = guest;
				attachedLease = id;
				lease.releaseInput = attachInput(guest, id);
				guest.once("destroyed", () => {
					lease.releaseInput?.();
					this.leases.delete(id);
				});
			});
			guest.setWindowOpenHandler(({ url, postBody }) => {
				const lease = attachedLease === void 0 ? void 0 : this.leases.get(attachedLease);
				if (attachedLease !== void 0 && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed() && postBody === void 0 && this.allowedNavigation(url)) {
					const request = {
						lease: attachedLease,
						url: new URL(url).href
					};
					owner.send(DESKTOP_IPC.browserOpenRequested, request);
				}
				return { action: "deny" };
			});
			guest.on("will-frame-navigate", (event) => {
				if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault();
			});
			guest.on("will-redirect", (event, url, _inPlace, mainFrame) => {
				if (mainFrame && !this.allowedNavigation(url)) event.preventDefault();
			});
			guest.on("will-attach-webview", (event) => {
				event.preventDefault();
			});
			guest.on("login", (event, _details, _authInfo, callback) => {
				event.preventDefault();
				callback();
			});
		});
		const releaseAll = () => {
			for (const [id, lease] of this.leases) if (lease.owner === owner) this.release(owner, id).catch((error) => {
				console.error(error);
			});
		};
		owner.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
			if (mainFrame && !inPlace) releaseAll();
		});
		owner.on("render-process-gone", releaseAll);
		owner.once("destroyed", releaseAll);
	}
	configureSession(browserSession) {
		browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
			callback(false);
		});
		browserSession.setPermissionCheckHandler(() => false);
		browserSession.setDevicePermissionHandler(() => false);
		browserSession.setDisplayMediaRequestHandler((_request, callback) => {
			callback({});
		});
		browserSession.on("will-download", (event) => {
			event.preventDefault();
		});
		browserSession.webRequest.onBeforeRequest((details, callback) => {
			const url = new URL(details.url);
			callback({ cancel: [
				"http:",
				"https:",
				"ws:",
				"wss:"
			].includes(url.protocol) ? url.username !== "" || url.password !== "" || this.isApplicationHost(url) : ![
				"about:",
				"data:",
				"blob:"
			].includes(url.protocol) });
		});
	}
	allowedNavigation(value) {
		if (!URL.canParse(value)) return false;
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "" && !this.isApplicationHost(url);
	}
	isApplicationHost(url) {
		const value = this.hostUrl();
		if (value === void 0) return false;
		const host = new URL(value);
		return url.port === host.port && (url.hostname === host.hostname || [
			"localhost",
			"127.0.0.1",
			"[::1]"
		].includes(url.hostname));
	}
};
//#endregion
//#region ../../packages/util/values/lib/index.js
/**
* Lazily scanned view of one JSON object's top-level fields, built from text
* that may still be streaming or from an already parsed object. Nothing is
* scanned until a reader asks; the view remembers every question it answered
* and reports changed answers when the owner refreshes for publication.
* Used for model tool-call arguments: a row reads the fields it
* cares about at whatever granularity it displays, at every stage of the call.
* @module @deepseek-ai/dsh-util-values/src/partial-json
*/
const SIMPLE_ESCAPES = {
	"\"": "\"",
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	"
};
const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
function isWhitespace(c) {
	return c === " " || c === "\n" || c === "\r" || c === "	";
}
function isHex(c) {
	return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
}
(class PartialArguments {
	/** The view of a call with no arguments available. */
	static EMPTY = PartialArguments.fromObject({});
	/**
	* View finished argument text without scanning it until a reader asks.
	* @param text - the complete argument JSON text.
	* @returns a sealed view.
	*/
	static fromText(text) {
		const view = new PartialArguments();
		view.append(text);
		view.sealed = true;
		return view;
	}
	/**
	* View an already parsed argument payload, such as a PTC dispatch object.
	* @param value - the parsed argument value.
	* @returns a sealed view; a non-object payload has no fields.
	*/
	static fromObject(value) {
		const view = new PartialArguments();
		view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
		view.sealed = true;
		return view;
	}
	/**
	* The source: text so far or a parsed object, plus whether it can still grow.
	* These are the only enumerable fields, so two views over the same source
	* compare equal structurally however far each has been read.
	*/
	chunks = [];
	object;
	sealed = false;
	#ends = [];
	#size = 0;
	#consumed = 0;
	#mode = "root";
	#escape = false;
	#keyStart = 0;
	#keyEscaped = false;
	#key = "";
	#current = null;
	#nestedEnds = [];
	#nestedInString = false;
	#invalidAt;
	#invalidValue = false;
	#entries = /* @__PURE__ */ new Map();
	#order = [];
	#reads = /* @__PURE__ */ new Map();
	/** Whether this view rejects further appends; does not scan text or register reads. */
	get isSealed() {
		return this.sealed;
	}
	/** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
	get invalid() {
		this.scan();
		return this.#mode === "invalid" || this.#invalidValue;
	}
	/**
	* Retain streamed argument text without scanning or comparing observed answers.
	* @param fragment - the text following every fragment appended before.
	*/
	append(fragment) {
		if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
		if (fragment.length === 0) return;
		this.chunks.push(fragment);
		this.#size += fragment.length;
		this.#ends.push(this.#size);
	}
	/**
	* Reconcile a streamed prefix with authoritative complete text without joining the fragments.
	* @param text - the final argument text, which replaces missing or conflicting deltas.
	* @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
	*/
	settle(text) {
		if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
		let offset = 0;
		for (const chunk of this.chunks) {
			if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
			offset += chunk.length;
		}
		this.chunks = text.length === 0 ? [] : [text];
		this.#ends = text.length === 0 ? [] : [text.length];
		this.sealed = true;
		return this;
	}
	/**
	* Compare observed answers and advance their publication baseline. Unread views remain unscanned.
	* @returns whether any observed answer changed since its first read or the preceding refresh.
	*/
	refresh() {
		if (this.#reads.size === 0) return false;
		this.scan();
		let changed = false;
		let completions = false;
		for (const read of this.#reads.values()) {
			if (read.completion) {
				completions = true;
				continue;
			}
			changed = this.refreshRead(read) || changed;
		}
		if (completions) {
			for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
		}
		if (this.sealed) this.#reads.clear();
		return changed;
	}
	refreshRead(read) {
		const now = read.answer();
		if (Object.is(now, read.last)) return false;
		read.last = now;
		return true;
	}
	/**
	* Check whether no further fields can arrive.
	* @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
	*/
	closed() {
		return this.remember("closed", "", () => this.closedNow());
	}
	/**
	* List discovered fields in first-appearance order.
	* @returns top-level keys seen so far, in first-appearance order.
	*/
	keys() {
		return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
	}
	/**
	* Check whether a top-level field has appeared.
	* @param key - argument name.
	* @returns whether the field has appeared (a string opened or another value began).
	*/
	has(key) {
		return this.remember("has", key, () => this.hasNow(key));
	}
	/**
	* Check whether a field's closing delimiter has arrived, without validating its contents.
	* @param key - argument name.
	* @returns whether its delimiter arrived and no content reader has reported an error for this value.
	*/
	complete(key) {
		return this.remember("complete", key, () => this.completeNow(key));
	}
	/**
	* Read string length without materializing its text.
	* @param key - argument name.
	* @param options - change granularity for a streaming string.
	* @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
	*/
	stringLength(key, options) {
		const step = Math.max(1, Math.floor(options?.step ?? 1));
		const offset = options?.offset ?? 0;
		return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
	}
	/**
	* Check a string against a decoded UTF-16 length limit without materializing it.
	* @param key - argument name.
	* @param maxLength - decoded UTF-16 limit, floored to at least zero.
	* @returns whether the string is longer than the limit; false when absent or not a string.
	*/
	stringExceeds(key, maxLength) {
		const limit = Math.max(0, Math.floor(maxLength));
		return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
	}
	/**
	* Read a decoded string, including a streaming prefix.
	* @param key - argument name.
	* @returns the string field's decoded text so far; undefined when absent or not a string.
	*/
	text(key) {
		return this.remember("text", key, () => this.textNow(key));
	}
	/**
	* Read at most the first decoded UTF-16 units of a string.
	* @param key - argument name.
	* @param maxLength - maximum decoded UTF-16 length, floored to at least one.
	* @returns the bounded string prefix; undefined when absent or not a string.
	*/
	textPrefix(key, maxLength) {
		const limit = Math.max(1, Math.floor(maxLength));
		return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
	}
	/**
	* Read a completed non-string argument.
	* @param key - argument name.
	* @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
	*/
	value(key) {
		return this.remember("value", key, () => this.valueNow(key));
	}
	/** Answer a question and, on a streaming view, remember it for change detection. */
	remember(kind, key, read, comparison) {
		this.scan();
		const result = read();
		if (!this.sealed) {
			const id = `${kind}/${key}`;
			if (!this.#reads.has(id)) this.#reads.set(id, {
				completion: kind === "complete",
				answer: comparison === void 0 ? read : () => comparison(read()),
				last: comparison === void 0 ? result : comparison(result)
			});
		}
		return result;
	}
	closedNow() {
		return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
	}
	keysNow() {
		return this.object === void 0 ? this.#order : Object.keys(this.object);
	}
	hasNow(key) {
		return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
	}
	completeNow(key) {
		if (this.object !== void 0) return Object.hasOwn(this.object, key);
		const entry = this.#entries.get(key);
		return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
	}
	lengthNow(key, limit = Number.POSITIVE_INFINITY) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.length : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
		const read = entry.length ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, limit, false);
		return read.length;
	}
	textNow(key) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
			let text;
			try {
				text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
			} catch (_error) {}
			if (text !== void 0) entry.text = {
				at: entry.end,
				length: text.length,
				text
			};
		}
		const read = entry.text ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, Number.POSITIVE_INFINITY, true);
		return read.text;
	}
	textPrefixNow(key, maxLength) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.slice(0, maxLength) : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
		let read = prefixes.get(maxLength);
		if (read === void 0) {
			read = {
				at: entry.start,
				length: 0,
				text: ""
			};
			prefixes.set(maxLength, read);
		}
		this.readString(entry, read, maxLength, true);
		return read.text;
	}
	valueNow(key) {
		if (this.object !== void 0) {
			if (!Object.hasOwn(this.object, key)) return void 0;
			const field = this.object[key];
			return typeof field === "string" ? void 0 : field;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
		if (entry.parsed === void 0) try {
			entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
		} catch (_error) {
			entry.invalid = true;
			this.#invalidValue = true;
		}
		return entry.parsed;
	}
	chunkAt(at) {
		let low = 0;
		let high = this.#ends.length;
		while (low < high) {
			const mid = low + high >>> 1;
			if (this.#ends[mid] <= at) low = mid + 1;
			else high = mid;
		}
		return low;
	}
	/** Materialize only a requested range, never the cumulative source. */
	slice(start, end) {
		if (start >= end) return "";
		const first = this.chunkAt(start);
		const last = this.chunkAt(end - 1);
		const base = first === 0 ? 0 : this.#ends[first - 1];
		if (first === last) return this.chunks[first].slice(start - base, end - base);
		const parts = [this.chunks[first].slice(start - base)];
		for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
		parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
		return parts.join("");
	}
	readString(entry, read, limit, materialize) {
		const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
		if (!entry.needsDecoding) {
			const length = Math.min(end - read.at, limit - read.length);
			if (length <= 0) return;
			if (materialize) read.text += this.slice(read.at, read.at + length);
			read.at += length;
			read.length += length;
			return;
		}
		let chunkIndex = this.chunkAt(read.at);
		while (read.at < end && read.length < limit) {
			const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
			const chunk = this.chunks[chunkIndex];
			const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
			const boundary = remaining.search(CONTENT_ESCAPE);
			const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
			if (length > 0) {
				if (materialize) read.text += remaining.slice(0, length);
				read.at += length;
				read.length += length;
				if (read.at === base + chunk.length) chunkIndex++;
				continue;
			}
			const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
			let decoded;
			let width = 2;
			if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
			if (remaining[0] === "\\" && type === "u") {
				const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
				let valid = true;
				for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
				if (valid) {
					if (hex.length < 4 && entry.end < 0) return;
					if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
				}
				width = 6;
			} else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
			if (decoded === void 0) {
				entry.invalidAt = read.at;
				this.#invalidValue = true;
				return;
			}
			if (materialize) read.text += decoded;
			read.length++;
			read.at += width;
			while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
		}
	}
	/** Locate new field ranges without decoding or parsing their contents. */
	scan() {
		if (this.object !== void 0 || this.#consumed === this.#size) return;
		for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
			const pending = this.chunks[i];
			const base = i === 0 ? 0 : this.#ends[i - 1];
			for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
				if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
					const end = this.stringBoundary(pending, index);
					this.#consumed += end - index;
					index = end;
					if (index === pending.length) break;
				}
				this.step(pending[index], this.#consumed);
				this.#consumed++;
			}
		}
	}
	/** Only raw quotes and their preceding backslash runs can terminate a string. */
	stringBoundary(fragment, start) {
		let at = start;
		while (true) {
			const quote = fragment.indexOf("\"", at);
			const end = quote < 0 ? fragment.length : quote;
			if (this.#mode === "string") {
				const entry = this.#current;
				if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
			}
			let slashStart = end;
			while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
			const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
			this.#escape = quote < 0 && escaped;
			if (quote < 0 || !escaped) return end;
			at = quote + 1;
		}
	}
	step(c, at) {
		switch (this.#mode) {
			case "root":
				if (isWhitespace(c)) return;
				if (c === "{") {
					this.#mode = "key-or-end";
					return;
				}
				this.fail();
				return;
			case "key-or-end":
				if (isWhitespace(c)) return;
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key-only":
				if (isWhitespace(c)) return;
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key":
				this.stepKey(c, at);
				return;
			case "colon":
				if (isWhitespace(c)) return;
				if (c === ":") {
					this.#mode = "value";
					return;
				}
				this.fail();
				return;
			case "value":
				this.beginValue(c, at);
				return;
			case "string": {
				const entry = this.#current;
				entry.end = at;
				this.#current = null;
				this.#mode = "comma-or-end";
				return;
			}
			case "scalar":
				this.stepScalar(c, at);
				return;
			case "nested":
				this.stepNested(c, at);
				return;
			case "comma-or-end":
				if (isWhitespace(c)) return;
				if (c === ",") {
					this.#mode = "key-only";
					return;
				}
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				this.fail();
				return;
			case "closed":
				if (isWhitespace(c)) return;
				this.fail();
				return;
			/* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
			case "invalid": return;
			/* v8 ignore next 2 -- Every scanner mode has a handler above. */
			default: assertNever(this.#mode);
		}
	}
	fail() {
		this.#invalidAt = this.#consumed;
		this.#mode = "invalid";
		this.#current = null;
	}
	beginKey(at) {
		this.#mode = "key";
		this.#keyStart = at + 1;
		this.#keyEscaped = false;
		this.#escape = false;
	}
	stepKey(c, at) {
		if (c < " ") {
			this.fail();
			return;
		}
		if (this.#escape) {
			this.#escape = false;
			return;
		}
		if (c === "\\") {
			this.#escape = true;
			this.#keyEscaped = true;
			return;
		}
		if (c !== "\"") return;
		const raw = this.slice(this.#keyStart, at);
		if (this.#keyEscaped) try {
			this.#key = JSON.parse(`"${raw}"`);
		} catch (_error) {
			this.fail();
			return;
		}
		else this.#key = raw;
		this.#mode = "colon";
	}
	open(entry) {
		if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
		this.#entries.set(this.#key, entry);
		this.#current = entry;
	}
	beginValue(c, at) {
		if (isWhitespace(c)) return;
		if (c === "\"") {
			this.open({
				kind: "string",
				start: at + 1,
				end: -1,
				needsDecoding: false,
				invalidAt: void 0,
				length: void 0,
				text: void 0,
				prefixes: void 0
			});
			this.#escape = false;
			this.#mode = "string";
			return;
		}
		if (c === "}" || c === "," || c === ":" || c === "]") {
			this.fail();
			return;
		}
		this.open({
			kind: "value",
			start: at,
			end: -1,
			parsed: void 0,
			invalid: false
		});
		if (c === "{" || c === "[") {
			this.#mode = "nested";
			this.#nestedEnds = [c === "{" ? "}" : "]"];
			this.#nestedInString = false;
			this.#escape = false;
			return;
		}
		this.#mode = "scalar";
	}
	stepScalar(c, at) {
		if (c !== "," && c !== "}" && !isWhitespace(c)) return;
		this.closeValue(at);
		this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
	}
	stepNested(c, at) {
		if (this.#nestedInString) {
			this.#nestedInString = false;
			return;
		}
		if (c === "\"") {
			this.#nestedInString = true;
			return;
		}
		if (c === "{" || c === "[") {
			this.#nestedEnds.push(c === "{" ? "}" : "]");
			return;
		}
		if (c === "}" || c === "]") {
			if (this.#nestedEnds.pop() !== c) {
				this.fail();
				return;
			}
			if (this.#nestedEnds.length === 0) {
				this.closeValue(at + 1);
				this.#mode = "comma-or-end";
			}
		}
	}
	closeValue(end) {
		const entry = this.#current;
		entry.end = end;
		this.#current = null;
	}
});
/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
/**
* Mark an unreachable closed-union branch.
* @param value - impossible value; an unhandled typed variant fails at the call site.
* @param context - optional switch-site label included in the failure message.
* @returns never; a runtime value that escaped its type always throws.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
//#endregion
//#region ../../packages/util/crypto/lib/index.js
/**
* Random v4 UUID, minted from `crypto.getRandomValues`.
* @returns the UUID string.
*/
function randomUUID$1() {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
	const hex = Array.from(bytes, (byte, index) => {
		return (index === 6 ? byte & 15 | 64 : index === 8 ? byte & 63 | 128 : byte).toString(16).padStart(2, "0");
	}).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
//#endregion
//#region ../../packages/client/shortcuts/lib/protocol.js
const keyNames = {
	Slash: "/",
	Comma: ",",
	Period: ".",
	Backslash: "\\",
	Backquote: "`",
	Minus: "-",
	Equal: "=",
	BracketLeft: "[",
	BracketRight: "]",
	Semicolon: ";",
	Quote: "'",
	Enter: "Enter",
	Escape: "Esc",
	Space: "Space",
	Tab: "Tab",
	Backspace: "Backspace",
	Delete: "Delete",
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→"
};
const modifierOrder = [
	"control",
	"alt",
	"shift",
	"meta"
];
/**
* Expand logical modifiers, deduplicate, and validate the physical code.
* @param binding - declared binding.
* @param platform - receiving device platform.
* @returns canonical binding; unsupported codes throw during registration.
*/
function normalizeBinding(binding, platform) {
	const codes = [binding.code, ...binding.secondCode === void 0 ? [] : [binding.secondCode]];
	codes.sort();
	for (const code of codes) if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/u.test(code) && !Object.hasOwn(keyNames, code)) throw new Error(`Unsupported shortcut code: ${code}`);
	if (codes.length === 2 && codes[0] === codes[1]) throw new Error("Shortcut keys must be distinct");
	const modifiers = new Set(binding.modifiers.map((value) => value === "primary" ? platform === "macos" ? "meta" : "control" : value));
	return {
		code: codes[0],
		...codes[1] === void 0 ? {} : { secondCode: codes[1] },
		modifiers: modifierOrder.filter((value) => modifiers.has(value))
	};
}
/**
* Produce an exact-match index from a normalized binding.
* @param binding - normalized physical key and modifiers.
* @returns stable index used for both matching and conflict checks.
*/
function bindingKey(binding) {
	const codes = binding.secondCode === void 0 ? [binding.code] : [binding.code, binding.secondCode].sort();
	return [...binding.modifiers, ...codes].join("+");
}
/**
* Format keycaps and ARIA; Windows separates modifiers with plus signs, while chord keys remain adjacent.
* @param binding - normalized binding, or null for an unbound command.
* @param platform - receiving device platform.
* @returns visible keycaps; two-key chords omit ARIA shortcuts, which only support one non-modifier key.
*/
function presentBinding(binding, platform) {
	if (binding === null) return {
		keys: [],
		aria: void 0
	};
	const key = keyNames[binding.code] ?? binding.code.replace(/^(Key|Digit)/u, "");
	const symbols = platform === "macos" ? {
		control: "⌃",
		alt: "⌥",
		shift: "⇧",
		meta: "⌘"
	} : {
		control: "Ctrl",
		alt: "Alt",
		shift: "Shift",
		meta: "Meta"
	};
	const ariaNames = {
		control: "Control",
		alt: "Alt",
		shift: "Shift",
		meta: "Meta"
	};
	const ariaKey = binding.code === "Space" ? "Space" : binding.code === "Escape" ? "Escape" : binding.code.startsWith("Arrow") ? binding.code : key;
	const second = binding.secondCode === void 0 ? [] : [keyNames[binding.secondCode] ?? binding.secondCode.replace(/^(Key|Digit)/u, "")];
	const keys = [...binding.modifiers.map((value) => symbols[value]), key];
	return {
		keys: [...platform === "windows" ? keys.flatMap((label, index) => index === 0 ? [label] : ["+", label]) : keys, ...second],
		aria: binding.secondCode === void 0 ? [...binding.modifiers.map((value) => ariaNames[value]), ariaKey].join("+") : void 0
	};
}
/**
* Check Web combinations: Windows and macOS also admit any three or four modifiers; Linux retains the limited set.
* @param binding - normalized candidate.
* @param platform - receiving device platform.
* @returns whether this combination is admitted; admission does not guarantee browser or system delivery.
*/
function isWebBindingAllowed(binding, platform) {
	if (binding.secondCode !== void 0) return false;
	if (platform === "windows" || platform === "macos") {
		if (binding.modifiers.length >= 3) return true;
		const primary = platform === "macos" ? "meta" : "control";
		if (binding.modifiers.length === 1 && (["Comma", "Backslash"].includes(binding.code) && binding.modifiers[0] === primary || binding.code === "Backquote" && binding.modifiers[0] === "control")) return true;
		if (binding.modifiers.length === 2 && binding.modifiers.includes(primary) && (binding.modifiers.includes("alt") || binding.modifiers.includes("shift"))) return true;
	}
	return [
		{
			code: "Slash",
			modifiers: ["primary"]
		},
		{
			code: "Comma",
			modifiers: ["primary", "shift"]
		},
		{
			code: "Period",
			modifiers: ["primary", "shift"]
		}
	].some((candidate) => bindingKey(binding) === bindingKey(normalizeBinding(candidate, platform)));
}
/** Validated preference documents and deterministic conflict resolution, without browser dependencies. */
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const commandPattern = /^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/u;
/**
* Validate JSON binding fields before normalization; unknown fields are rejected to prevent lossy rewrites.
* @param value - file or IPC input.
* @returns a binding with a supported physical code, or null for explicit removal.
*/
function parseBinding(value) {
	if (value === null) return null;
	if (!record(value) || Object.keys(value).some((key) => key !== "code" && key !== "secondCode" && key !== "modifiers") || typeof value.code !== "string" || !Array.isArray(value.modifiers) || Object.hasOwn(value, "secondCode") && typeof value.secondCode !== "string" || !value.modifiers.every((modifier) => typeof modifier === "string" && [
		"primary",
		"control",
		"alt",
		"shift",
		"meta"
	].includes(modifier))) throw new Error("Invalid shortcut binding");
	const binding = {
		code: value.code,
		modifiers: value.modifiers,
		...typeof value.secondCode === "string" ? { secondCode: value.secondCode } : {}
	};
	normalizeBinding(binding, "windows");
	return binding;
}
/**
* Decode the complete document while preserving dormant command overrides.
* @param raw - stored JSON, or null for a missing document.
* @returns the accepted document or a classified read failure.
*/
function parseShortcutDocument(raw) {
	if (raw === null) return {
		schemaVersion: 1,
		profiles: {}
	};
	try {
		const value = JSON.parse(raw);
		if (!record(value)) return "invalid";
		if (typeof value.schemaVersion === "number" && value.schemaVersion > 2) return "future";
		if (value.schemaVersion !== 1 && value.schemaVersion !== 2 || !record(value.profiles) || Object.keys(value).some((key) => key !== "schemaVersion" && key !== "profiles")) return "invalid";
		const profiles = {};
		for (const [profile, overrides] of Object.entries(value.profiles)) {
			if (!/^(desktop|web):(macos|windows|linux)$/u.test(profile) || !record(overrides)) return "invalid";
			const bindings = {};
			for (const [id, binding] of Object.entries(overrides)) {
				if (!commandPattern.test(id)) return "invalid";
				const parsed = parseBinding(binding);
				if (value.schemaVersion === 1 && parsed?.secondCode !== void 0) return "invalid";
				bindings[id] = parsed;
			}
			profiles[profile] = bindings;
		}
		return {
			schemaVersion: value.schemaVersion,
			profiles
		};
	} catch (_error) {
		return "invalid";
	}
}
/**
* Check system, editor, and browser reservations using expanded physical modifiers.
* @param binding - normalized candidate.
* @param runtime - receiving application shell.
* @param platform - receiving device.
* @returns the rejection reason, or null when this combination is allowed.
*/
function bindingIssue(binding, runtime, platform) {
	const { code, modifiers } = binding;
	if (runtime === "desktop" && (platform === "windows" || platform === "macos")) return null;
	if (binding.secondCode !== void 0) return "unsupported-key";
	if (modifiers.length === 0 || modifiers.every((modifier) => modifier === "shift")) return "modifier-required";
	if ((platform === "windows" || platform === "macos") && modifiers.length >= 3) return null;
	if (runtime === "web" && (platform === "windows" || platform === "macos") && isWebBindingAllowed(binding, platform)) return null;
	const primary = modifiers.includes(platform === "macos" ? "meta" : "control");
	if ([
		"Escape",
		"Tab",
		"Space",
		"Backspace",
		"Delete",
		"ArrowUp",
		"ArrowDown",
		"ArrowLeft",
		"ArrowRight"
	].includes(code) || code === "Enter" && !modifiers.includes("alt") || primary && [
		"KeyC",
		"KeyV",
		"KeyX",
		"KeyZ",
		"KeyY",
		"KeyQ",
		"KeyH"
	].includes(code) || primary && code === "KeyA" && !modifiers.includes("shift") || platform !== "macos" && (modifiers.includes("meta") || modifiers.includes("alt") && ["F4", "F2"].includes(code)) || platform === "macos" && modifiers.includes("control") && modifiers.includes("meta") || platform === "macos" && modifiers.includes("alt") && !primary) return "reserved";
	if (runtime === "web" && !isWebBindingAllowed(binding, platform)) return "unsupported-browser";
	return null;
}
/**
* Select the command owner's explicit default for one device profile.
* @param definition - command identity and per-profile defaults.
* @param runtime - receiving shell.
* @param platform - receiving device.
* @returns the declared physical binding, or undefined for an unbound action.
*/
function resolveShortcutDefault(definition, runtime, platform) {
	return definition.defaults[`${runtime}:${platform}`];
}
/**
* Resolve overrides and conflicts independently of registration order. Explicit overrides displace defaults.
* @param definitions - active commands.
* @param document - accepted preferences.
* @param runtime - receiving shell.
* @param platform - receiving device.
* @returns every active command, including unavailable conflicting bindings.
*/
function effectiveShortcuts(definitions, document, runtime, platform) {
	const overrides = document.profiles[`${runtime}:${platform}`] ?? {};
	const fixed = definitions.flatMap((row) => row.fixed?.map((binding) => ({
		id: row.id,
		binding: normalizeBinding(binding, platform)
	})) ?? []);
	const rows = definitions.filter((row) => row.fixed === void 0).map(({ id, defaults }) => {
		const modified = Object.hasOwn(overrides, id);
		const candidate = modified ? overrides[id] : resolveShortcutDefault({
			id,
			defaults
		}, runtime, platform);
		const binding = candidate == null ? null : normalizeBinding(candidate, platform);
		return {
			id,
			binding,
			modified,
			issue: binding === null ? null : bindingIssue(binding, runtime, platform)
		};
	});
	return rows.map((row) => {
		const binding = row.binding;
		return {
			...row,
			conflicts: binding === null ? [] : [...new Set([...rows.filter((other) => other.id !== row.id && other.binding !== null && other.issue === null && overlappingBindings(other.binding, binding) && (!row.modified || other.modified)).map((other) => other.id), ...fixed.filter((other) => overlappingBindings(other.binding, binding)).map((other) => other.id)])]
		};
	});
}
/**
* Detect identical combinations or a single key contained in a two-key chord.
* @param left - normalized candidate.
* @param right - normalized occupied binding.
* @returns whether both bindings require the same modifiers and overlap.
*/
function overlappingBindings(left, right) {
	if (left.modifiers.join("+") !== right.modifiers.join("+")) return false;
	if (left.secondCode !== void 0 && right.secondCode !== void 0) return bindingKey(left) === bindingKey(right);
	return [left.code, left.secondCode].some((code) => code !== void 0 && (code === right.code || code === right.secondCode));
}
/**
* Apply an edit without modifying other profiles or dormant overrides.
* @param document - accepted document.
* @param edit - validated operation.
* @param runtime - current shell.
* @param platform - current device.
* @returns the candidate document, pending conflict checks and durable storage.
*/
function editShortcutDocument(document, edit, runtime, platform) {
	const schemaVersion = runtime === "desktop" && (platform === "macos" || platform === "windows") ? 2 : document.schemaVersion;
	const profile = `${runtime}:${platform}`;
	let overrides = { ...document.profiles[profile] };
	switch (edit.type) {
		case "set":
			overrides[edit.id] = edit.binding;
			break;
		case "reset": {
			const { [edit.id]: _removed, ...remaining } = overrides;
			overrides = remaining;
			break;
		}
		case "reset-all":
			overrides = {};
			break;
		/* v8 ignore next -- parseShortcutEdit validates this closed union before persistence. */
		default: return assertNever(edit, "shortcut edit");
	}
	return {
		schemaVersion,
		profiles: {
			...document.profiles,
			[profile]: overrides
		}
	};
}
/**
* Validate a preference edit at the Desktop IPC boundary.
* @param value - untrusted renderer request.
* @returns the constrained operation; malformed requests throw.
*/
function parseShortcutEdit(value) {
	if (!record(value)) throw new Error("Invalid shortcut edit");
	if (value.type === "reset-all" && Object.keys(value).length === 1) return { type: value.type };
	if (typeof value.id !== "string" || !commandPattern.test(value.id)) throw new Error("Invalid shortcut command");
	if (value.type === "reset" && Object.keys(value).length === 2) return {
		type: "reset",
		id: value.id
	};
	if (value.type === "set" && Object.keys(value).length === 3) return {
		type: "set",
		id: value.id,
		binding: parseBinding(value.binding)
	};
	throw new Error("Invalid shortcut edit");
}
/**
* Validate the trusted product's serializable command catalog at IPC ingress.
* @param value - renderer-supplied active command definitions.
* @returns validated definitions; duplicate IDs, overlapping defaults, and unsupported combinations throw.
*/
function parseShortcutDefinitions(value) {
	if (!Array.isArray(value)) throw new Error("Invalid shortcut catalog");
	const ids = /* @__PURE__ */ new Set();
	for (const entry of value) {
		if (!record(entry) || typeof entry.id !== "string" || !commandPattern.test(entry.id) || ids.has(entry.id) || !record(entry.defaults) || Object.keys(entry).some((key) => key !== "id" && key !== "defaults" && key !== "fixed")) throw new Error("Invalid shortcut definition");
		ids.add(entry.id);
		if (Object.hasOwn(entry, "fixed")) {
			if (!Array.isArray(entry.fixed) || entry.fixed.length === 0 || Object.keys(entry.defaults).length > 0) throw new Error("Invalid fixed shortcut definition");
			for (const binding of entry.fixed) if (parseBinding(binding) === null) throw new Error("Invalid fixed shortcut binding");
		}
		for (const [profile, candidate] of Object.entries(entry.defaults)) {
			if (!/^(desktop|web):(macos|windows|linux)$/u.test(profile)) throw new Error("Invalid shortcut profile");
			if (parseBinding(candidate) === null) throw new Error("Invalid shortcut default");
		}
	}
	const definitions = value;
	for (const runtime of ["desktop", "web"]) for (const platform of [
		"macos",
		"windows",
		"linux"
	]) {
		const bindings = [];
		for (const entry of definitions) {
			const binding = resolveShortcutDefault(entry, runtime, platform);
			if (binding === void 0) continue;
			const normalized = normalizeBinding(binding, platform);
			if (bindings.some((other) => overlappingBindings(other, normalized)) || bindingIssue(normalized, runtime, platform) !== null) throw new Error("Conflicting or reserved shortcut default");
			bindings.push(normalized);
		}
	}
	return definitions;
}
/** Serialized preference transactions; storage owners publish only accepted writes or read diagnostics. */
/**
* Create a disabled initial snapshot for asynchronous adapter startup.
* @returns a fresh configuration with no accepted persisted state.
*/
function initialShortcutConfig() {
	return {
		revision: randomUUID$1(),
		sequence: 0,
		document: {
			schemaVersion: 1,
			profiles: {}
		},
		status: "loading",
		error: null,
		usingDefaults: true
	};
}
/** Single-writer coordinator shared by localStorage and Electron's atomic file adapter. */
var ShortcutPersistence = class {
	storage;
	runtime;
	platform;
	rereadBeforeWrite;
	publish;
	snapshot = initialShortcutConfig();
	raw;
	queue = Promise.resolve();
	definitions = null;
	active = true;
	constructor(storage, runtime, platform, rereadBeforeWrite, publish) {
		this.storage = storage;
		this.runtime = runtime;
		this.platform = platform;
		this.rereadBeforeWrite = rereadBeforeWrite;
		this.publish = publish;
	}
	/**
	* Install or revoke a product catalog and invalidate drafts from its previous lifetime.
	* @param definitions - current trusted definitions, or null while the product is not ready.
	*/
	setDefinitions(definitions) {
		this.definitions = definitions;
		this.accept({ ...this.snapshot });
	}
	/** Stop accepting edits or publishing late completions. */
	dispose() {
		this.active = false;
	}
	/**
	* Read the current file; failures retain the last accepted document and disable ordinary writes.
	* @returns the accepted snapshot or diagnostic snapshot.
	*/
	readCurrent() {
		return this.serialize(() => this.read());
	}
	/**
	* Compare the draft revision, validate the complete candidate, then persist before publishing.
	* @param edit - constrained preference operation.
	* @param revision - state against which the user reviewed the edit.
	* @returns a classified outcome and the currently accepted snapshot.
	*/
	edit(edit, revision) {
		return this.serialize(async () => {
			if (this.rereadBeforeWrite) await this.read();
			const result = (status) => ({
				status,
				snapshot: this.snapshot
			});
			if (!this.active || this.definitions === null || this.snapshot.status === "loading") return result("not-ready");
			if (revision !== this.snapshot.revision) return result("stale");
			if (this.snapshot.status === "unreadable") return result("unreadable");
			if ((edit.type === "set" || edit.type === "reset") && !this.definitions.some((row) => row.id === edit.id && row.fixed === void 0)) return result("not-ready");
			const document = editShortcutDocument(this.snapshot.document, edit, this.runtime, this.platform);
			const rows = effectiveShortcuts(this.definitions, document, this.runtime, this.platform);
			const invalid = rows.find((row) => (edit.type === "reset-all" || row.id === edit.id) && (row.issue !== null || row.conflicts.length > 0));
			const displaced = edit.type === "set" ? rows.find((row) => row.conflicts.includes(edit.id)) : void 0;
			if (invalid !== void 0 || displaced !== void 0) return {
				...result("conflict"),
				...invalid?.issue ? { issue: invalid.issue } : {},
				conflicts: invalid?.conflicts.length ? invalid.conflicts : displaced === void 0 ? [] : [displaced.id]
			};
			try {
				const raw = `${JSON.stringify(document, null, 2)}\n`;
				await this.storage.write(raw);
				this.raw = raw;
				this.accept({
					...this.snapshot,
					document,
					status: "ready",
					error: null,
					usingDefaults: false
				});
				return result("saved");
			} catch (_error) {
				return result("write-failed");
			}
		});
	}
	serialize(operation) {
		const next = this.queue.then(operation);
		this.queue = next.catch(() => void 0);
		return next;
	}
	accept(snapshot) {
		this.snapshot = {
			...snapshot,
			sequence: this.snapshot.sequence + 1,
			revision: randomUUID$1()
		};
		if (!this.active) return;
		try {
			this.publish(this.snapshot);
		} catch (error) {
			console.error("Shortcut configuration subscriber failed:", error);
		}
	}
	async read() {
		let raw;
		try {
			raw = await this.storage.read();
		} catch (_error) {
			if (this.snapshot.error !== "read") this.accept({
				...this.snapshot,
				status: "unreadable",
				error: "read"
			});
			return this.snapshot;
		}
		if (raw === this.raw && this.snapshot.error !== "read") return this.snapshot;
		this.raw = raw;
		const document = parseShortcutDocument(raw);
		if (typeof document === "string") this.accept({
			...this.snapshot,
			status: "unreadable",
			error: document
		});
		else this.accept({
			...this.snapshot,
			document,
			status: "ready",
			error: null,
			usingDefaults: raw === null
		});
		return this.snapshot;
	}
};
//#endregion
//#region lib/types/keybindings.js
/** Device-local shortcut preferences in Electron userData; writes share one serialized coordinator. */
/**
* Open the device configuration with atomic replacement.
* @param userData - Electron-owned userData directory, never a Renderer-supplied path.
* @param platform - local input platform.
* @param publish - updates the native binding index and trusted product page after commit.
* @returns the single-writer transaction coordinator.
*/
function desktopKeybindings(userData, platform, publish) {
	const path = join(userData, "keybindings.json");
	return new ShortcutPersistence({
		read: async () => {
			try {
				return await readFile$1(path, "utf8");
			} catch (error) {
				if (error.code === "ENOENT") return null;
				throw error;
			}
		},
		write: (raw) => writeFileAtomic(path, raw, {
			mode: 384,
			dirMode: 448
		})
	}, "desktop", platform, false, publish);
}
//#endregion
//#region lib/types/keyboard.js
/** Product-window preference IPC and native menu interception during physical-key dispatch/recording. */
/**
* Install application-owned configuration handlers and attach each product window's input lifecycle.
* @param getWindow - current product window.
* @param userData - Electron-resolved device preference directory.
* @param platform - local device platform.
* @param updateMenu - rebuild the application menu when the close accelerator or availability changes.
* @param overlayInput - Current shell-owned input blocking state for the product window.
* @returns menu construction, editor key delivery, window attachment, and teardown operations.
*/
function installDesktopShortcuts(getWindow, userData, platform, updateMenu, overlayInput) {
	let definitions = [];
	let recording = false;
	let revision;
	let closeBinding = null;
	let editingInput;
	const scopedDesktop = platform === "windows" || platform === "macos";
	const disposers = /* @__PURE__ */ new Set();
	const guestInputs = /* @__PURE__ */ new Map();
	const closeAccelerator = () => presentBinding(closeBinding, platform).aria?.replace("Meta+", "Command+").replace(/Arrow(Up|Down|Left|Right)$/u, "$1");
	const sendMenuClose = () => {
		const window = getWindow();
		if (window === void 0 || window.isDestroyed() || !window.isFocused() || !window.isEnabled() || revision === void 0 || recording || overlayInput(window).blocked) return;
		window.webContents.send(DESKTOP_IPC.shortcutsInput, {
			kind: "menu",
			commandId: "page.close",
			revision
		});
	};
	let keys = /* @__PURE__ */ new Set();
	const publish = (snapshot) => {
		const wasEnabled = revision !== void 0;
		const previousAccelerator = closeAccelerator();
		revision = definitions.length === 0 || snapshot.status === "loading" ? void 0 : snapshot.revision;
		const rows = snapshot.status === "loading" ? [] : effectiveShortcuts(definitions, snapshot.document, "desktop", platform);
		keys = new Set(rows.flatMap((row) => row.binding !== null && row.issue === null && row.conflicts.length === 0 ? [bindingKey(row.binding)] : []));
		const close = rows.find((row) => row.id === "page.close");
		closeBinding = close?.issue === null && close.conflicts.length === 0 ? close.binding : null;
		if (wasEnabled !== (revision !== void 0) || previousAccelerator !== closeAccelerator()) updateMenu();
		const window = getWindow();
		if (window !== void 0 && !window.isDestroyed() && window.webContents.mainFrame.url.startsWith("dsh-app://app/")) window.webContents.send(DESKTOP_IPC.shortcutsChanged, snapshot);
	};
	const persistence = desktopKeybindings(userData, platform, publish);
	const assertSender = (event) => {
		const window = getWindow();
		if (window === void 0 || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("desktop shortcuts: rejected sender");
		assertDesktopSender(event, ["app"]);
		return window;
	};
	ipcMain.handle(DESKTOP_IPC.shortcutsGet, async (event, input) => {
		assertSender(event);
		definitions = parseShortcutDefinitions(input);
		persistence.setDefinitions(definitions);
		return persistence.readCurrent();
	});
	ipcMain.handle(DESKTOP_IPC.shortcutsEdit, async (event, input, expectedRevision) => {
		assertSender(event);
		if (typeof expectedRevision !== "string") throw new Error("desktop shortcuts: invalid revision");
		return persistence.edit(parseShortcutEdit(input), expectedRevision);
	});
	ipcMain.handle(DESKTOP_IPC.shortcutsRecording, (event, active) => {
		const window = assertSender(event);
		if (typeof active !== "boolean") throw new Error("desktop shortcuts: invalid recording state");
		recording = active;
		window.webContents.setIgnoreMenuShortcuts(active);
	});
	ipcMain.handle(DESKTOP_IPC.shortcutsCloseWindow, (event, expected) => {
		const window = assertSender(event);
		if (expected !== revision || revision === void 0 || recording || !window.isFocused() || !window.isEnabled() || overlayInput(window).blocked) return;
		window.close();
	});
	function attachInput(window, contents, guestName) {
		let deadKey = false;
		const held = /* @__PURE__ */ new Set();
		const consumed = /* @__PURE__ */ new Map();
		let inputFrame = null;
		let inputRevision;
		let overlayRevision = overlayInput(window).revision;
		const resetInput = () => {
			deadKey = false;
			held.clear();
			consumed.clear();
			inputFrame = null;
			inputRevision = void 0;
			if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false);
		};
		if (guestName !== void 0) guestInputs.set(contents, {
			window,
			reset: resetInput
		});
		const resetWindow = () => {
			resetInput();
			for (const guest of guestInputs.values()) if (guest.window === window) guest.reset();
		};
		const clear = () => {
			resetInput();
			if (guestName !== void 0) return;
			definitions = [];
			keys.clear();
			recording = false;
			persistence.setDefinitions(null);
		};
		const navigation = (event) => {
			if (event.isMainFrame && !event.isSameDocument) clear();
		};
		const beforeInput = (event, input) => {
			const overlay = overlayInput(window);
			if (overlay.revision !== overlayRevision) {
				resetInput();
				overlayRevision = overlay.revision;
			}
			if (overlay.blocked) {
				event.preventDefault();
				return;
			}
			if (event.defaultPrevented) {
				resetInput();
				return;
			}
			if (editingInput === contents) {
				held.clear();
				consumed.clear();
				contents.setIgnoreMenuShortcuts(true);
				return;
			}
			if (window !== getWindow() || !window.isFocused() || !window.isEnabled() || revision === void 0 || guestName !== void 0 && !contents.isFocused()) {
				contents.setIgnoreMenuShortcuts(false);
				held.clear();
				consumed.clear();
				return;
			}
			const modifiers = [
				"control",
				"alt",
				"shift",
				"meta"
			].filter((modifier) => input[modifier]);
			const key = bindingKey({
				code: input.code,
				modifiers
			});
			const match = keys.has(key);
			const menuMatch = closeBinding !== null && closeBinding.secondCode === void 0 && modifiers.join("+") === closeBinding.modifiers.join("+") && input.key.toUpperCase() === (closeBinding.code.startsWith("Key") ? closeBinding.code.slice(3) : input.code === closeBinding.code ? input.key.toUpperCase() : "");
			contents.setIgnoreMenuShortcuts(recording || match || menuMatch);
			const frame = contents.focusedFrame;
			const composing = input.isComposing || input.key === "Dead" || deadKey || input.modifiers.includes("altgr");
			if (input.type === "keyDown") deadKey = input.key === "Dead";
			if (recording || composing || frame === null) {
				held.clear();
				consumed.clear();
				return;
			}
			let binding = {
				code: input.code,
				modifiers
			};
			let priority = false;
			if (scopedDesktop) {
				if (frame !== inputFrame || inputRevision !== revision) {
					held.clear();
					inputFrame = frame;
					inputRevision = revision;
				}
				const modifierKey = /^(Control|Alt|Shift|Meta)(Left|Right)$/u.test(input.code);
				if (input.type === "keyUp") {
					if (consumed.get(input.code) === "press") event.preventDefault();
					consumed.delete(input.code);
					held.delete(input.code);
					if (modifierKey) held.clear();
					return;
				}
				if (!input.isAutoRepeat) consumed.delete(input.code);
				if (modifierKey) {
					held.clear();
					return;
				}
				if (input.isAutoRepeat && consumed.has(input.code) && !match) {
					event.preventDefault();
					return;
				}
				if (input.isAutoRepeat && !held.has(input.code) && !match) return;
				held.add(input.code);
				const codes = [input.code, ...[...held].filter((value) => value !== input.code)];
				codes.sort();
				const pair = {
					code: codes[0],
					...codes[1] === void 0 ? {} : { secondCode: codes[1] },
					modifiers
				};
				priority = keys.has(key);
				if (codes.length === 2 && keys.has(bindingKey(pair))) {
					binding = pair;
					priority = true;
				}
			}
			const main = guestName === void 0 && frame === contents.mainFrame;
			if (!priority && (main || !match)) return;
			event.preventDefault();
			if (input.type !== "keyDown") return;
			if (scopedDesktop) {
				if (!input.isAutoRepeat) {
					if (binding.secondCode !== void 0) {
						consumed.set(binding.code, "repeat");
						consumed.set(binding.secondCode, "repeat");
					}
					consumed.set(input.code, "press");
				}
				held.clear();
			}
			let embedding = frame;
			while (guestName === void 0 && !main && embedding.parent !== null && embedding.parent !== contents.mainFrame) embedding = embedding.parent;
			window.webContents.send(DESKTOP_IPC.shortcutsInput, {
				kind: guestName === void 0 ? main ? "keyboard" : "iframe" : "webview",
				revision,
				frameName: guestName ?? (main ? "" : embedding.name),
				code: binding.code,
				...binding.secondCode === void 0 ? {} : { secondCode: binding.secondCode },
				repeat: input.isAutoRepeat,
				control: input.control,
				alt: input.alt,
				shift: input.shift,
				meta: input.meta
			});
		};
		const dispose = () => {
			contents.off("did-start-navigation", navigation);
			contents.off("before-input-event", beforeInput);
			contents.off("blur", resetInput);
			contents.off("destroyed", dispose);
			if (guestName === void 0) {
				window.off("blur", resetWindow);
				window.off("closed", closed);
			}
			disposers.delete(dispose);
			guestInputs.delete(contents);
			if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false);
		};
		const closed = () => {
			clear();
			dispose();
		};
		contents.on("did-start-navigation", navigation);
		contents.on("before-input-event", beforeInput);
		contents.on("blur", resetInput);
		contents.once("destroyed", dispose);
		if (guestName === void 0) {
			window.on("closed", closed);
			window.on("blur", resetWindow);
		}
		disposers.add(dispose);
		return dispose;
	}
	return {
		sendEditingKey(keyCode, modifiers) {
			const window = getWindow();
			if (window === void 0 || window.isDestroyed() || overlayInput(window).blocked) return;
			const contents = [...guestInputs].find(([guest, owner]) => owner.window === window && !guest.isDestroyed() && guest.isFocused())?.[0] ?? window.webContents;
			contents.focus();
			const previous = editingInput;
			editingInput = contents;
			try {
				contents.sendInputEvent({
					type: "keyDown",
					keyCode,
					modifiers
				});
				contents.sendInputEvent({
					type: "keyUp",
					keyCode,
					modifiers
				});
			} finally {
				editingInput = previous;
				if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(recording);
			}
		},
		fileMenu: (labels) => {
			const accelerator = closeAccelerator();
			return {
				label: labels.fileMenu,
				submenu: [{
					id: "dsh-page-close",
					label: labels.closePage,
					enabled: revision !== void 0,
					...accelerator === void 0 ? {} : { accelerator },
					click: sendMenuClose
				}]
			};
		},
		attach(window) {
			attachInput(window, window.webContents);
		},
		attachGuest: attachInput,
		dispose() {
			for (const dispose of disposers) dispose();
			persistence.dispose();
			for (const channel of [
				DESKTOP_IPC.shortcutsGet,
				DESKTOP_IPC.shortcutsEdit,
				DESKTOP_IPC.shortcutsRecording,
				DESKTOP_IPC.shortcutsCloseWindow
			]) ipcMain.removeHandler(channel);
		}
	};
}
//#endregion
//#region lib/types/update-overlay.js
/** Isolated update documents share their owner's native window and input lifetime. */
/** Tracks isolated update views and each owner's keyboard-blocking revision. */
var DesktopUpdateOverlays = class {
	inputs = /* @__PURE__ */ new WeakMap();
	/** @param parent - Product window. @returns Blocking state and attachment/release revision. */
	input(parent) {
		const state = this.inputs.get(parent);
		return {
			revision: state?.revision ?? 0,
			blocked: state?.blocked ?? false
		};
	}
	/**
	* @param parent - Native owner; its caption remains operable.
	* @param preload - Isolated shell preload.
	* @returns Document attached inside the owner, without showing or activating a native window.
	*/
	create(parent, preload) {
		const view = new WebContentsView({ webPreferences: {
			preload,
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true
		} });
		const ownerContents = parent.webContents;
		const contents = view.webContents;
		const input = this.inputs.get(parent) ?? {
			revision: 0,
			active: 0,
			get blocked() {
				return this.active > 0;
			}
		};
		this.inputs.set(parent, input);
		input.active++;
		input.revision++;
		const resize = () => {
			const { width, height } = parent.getContentBounds();
			const top = process.platform === "win32" ? 40 : 0;
			view.setBounds({
				x: 0,
				y: top,
				width,
				height: Math.max(0, height - top)
			});
		};
		const focus = () => {
			if (!parent.isDestroyed() && parent.isFocused() && !contents.isDestroyed()) contents.focus();
		};
		const block = (event) => {
			event.preventDefault();
			focus();
		};
		const destroy = () => {
			if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
		};
		const release = () => {
			parent.off("resize", resize);
			parent.off("focus", focus);
			parent.off("closed", destroy);
			ownerContents.off("before-input-event", block);
			input.active--;
			input.revision++;
			if (!parent.isDestroyed()) {
				parent.contentView.removeChildView(view);
				if (parent.isFocused()) ownerContents.focus();
			}
		};
		view.setBackgroundColor("#00000000");
		parent.contentView.addChildView(view);
		resize();
		parent.on("resize", resize);
		parent.on("focus", focus);
		parent.once("closed", destroy);
		ownerContents.prependListener("before-input-event", block);
		contents.once("destroyed", release);
		contents.on("did-finish-load", focus);
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
		return {
			webContents: contents,
			focus,
			destroy,
			isDestroyed: () => contents.isDestroyed(),
			loadURL: (url) => contents.loadURL(url)
		};
	}
};
//#endregion
//#region lib/types/quit-confirmation.js
/** Native quit confirmation; quitting proceeds silently only when the Host reports nothing to interrupt. */
/**
* Choose the confirmation copy for one inspection result.
* @param inspection - Host answer, or `unknown` when the inspection failed or missed its deadline.
* @returns the explanation key; an unknown state warns about running tasks rather than quitting silently.
*/
function resolveDesktopQuitPrompt(inspection) {
	if (inspection === "unknown") return "quitActiveTasks";
	if (inspection.activeTasks && inspection.scheduledTasks) return "quitActiveAndScheduledTasks";
	if (inspection.activeTasks) return "quitActiveTasks";
	if (inspection.scheduledTasks) return "quitScheduledTasks";
}
/** One quit decision at a time; repeated quit requests join the open confirmation instead of stacking. */
var DesktopQuitConfirmation = class {
	options;
	pending;
	disposed = false;
	/** @param options - Locale, inspection, and native dialog collaborators. */
	constructor(options) {
		this.options = options;
	}
	/**
	* Decide whether the quit may proceed. The inspection runs once per decision; work that starts or ends
	* while the confirmation is open does not change its copy, and approval never re-inspects.
	* @returns true to quit now, false when the user cancelled.
	*/
	confirm() {
		if (this.disposed) return Promise.resolve(false);
		if (this.pending !== void 0) {
			this.options.focus();
			return this.pending;
		}
		const pending = this.decide().finally(() => {
			if (this.pending === pending) this.pending = void 0;
		});
		this.pending = pending;
		return pending;
	}
	/**
	* The application is quitting through a path that does not ask: a pending decision resolves to
	* false without opening a box, and later requests do the same. An already open native box has no
	* close API and disappears with the process.
	*/
	dispose() {
		this.disposed = true;
	}
	async decide() {
		const inspection = this.options.inspect();
		if (inspection === void 0) return true;
		const prompt = resolveDesktopQuitPrompt(await inspection.catch((error) => {
			console.warn("desktop quit: task inspection unavailable", error);
			return "unknown";
		}));
		if (this.disposed) return false;
		if (prompt === void 0) return true;
		const { messages } = this.options.locale();
		const windows = (this.options.platform ?? process.platform) === "win32";
		const result = await this.options.show({
			type: windows ? "none" : "warning",
			...windows && this.options.icon !== void 0 ? { icon: this.options.icon } : {},
			title: messages.aboutProduct,
			message: messages.quitTitle,
			detail: messages[prompt],
			buttons: [messages.quit, messages.cancel],
			defaultId: 0,
			cancelId: 1,
			noLink: true
		});
		if (this.disposed) return false;
		return result.response === 0;
	}
};
//#endregion
//#region lib/types/tray.js
/** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */
/** Tray icon present for the whole run, not only while the window is hidden. */
var DesktopTray = class {
	options;
	tray;
	/** @param options - Icon path, locale reader, and the open and quit actions. */
	constructor(options) {
		this.options = options;
		const tray = new Tray(nativeImage.createFromPath(options.iconPath));
		this.tray = tray;
		tray.on("click", () => {
			options.open();
		});
		this.relabel();
	}
	/** Rebuild the tooltip and context menu in the current locale. */
	relabel() {
		const tray = this.tray;
		if (tray === void 0) return;
		const { messages } = this.options.locale();
		tray.setToolTip(messages.aboutProduct);
		tray.setContextMenu(Menu.buildFromTemplate([
			{
				label: messages.openApplication,
				click: () => {
					this.options.open();
				}
			},
			{ type: "separator" },
			{
				label: messages.quitApplication,
				click: () => {
					this.options.quit();
				}
			}
		]));
	}
	/** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */
	dispose() {
		const tray = this.tray;
		this.tray = void 0;
		tray?.destroy();
	}
};
//#endregion
//#region lib/types/background-notice.js
/** One-time Windows confirmation before hiding the application in the tray. */
/** Only an explicit acknowledgement permits the first hide; cancelled prompts remain eligible. */
var DesktopBackgroundNotice = class {
	options;
	acknowledged = false;
	pending = false;
	disposed = false;
	/** @param options - Marker path, localized copy, and shell dialog actions. */
	constructor(options) {
		this.options = options;
	}
	/**
	* Request a window hide, prompting until acknowledged and coalescing repeated requests.
	* @param hide - Hide the still-owned window after acknowledgement, or immediately when already recorded.
	*/
	close(hide) {
		if (this.disposed) return;
		if (this.pending) {
			this.options.focus();
			return;
		}
		if (this.acknowledged || existsSync(this.options.markerPath)) {
			hide();
			return;
		}
		this.pending = true;
		this.confirm(hide);
	}
	/** Ignore late dialog responses after application shutdown begins. */
	dispose() {
		this.disposed = true;
	}
	async confirm(hide) {
		try {
			const { messages } = this.options.locale();
			const result = await this.options.show({
				type: "info",
				title: messages.aboutProduct,
				message: messages.backgroundNoticeBody,
				buttons: [messages.backgroundNoticeConfirm],
				defaultId: 0,
				cancelId: -1
			});
			if (this.disposed || result.response !== 0) return;
			this.acknowledged = true;
			try {
				mkdirSync(dirname(this.options.markerPath), { recursive: true });
				writeFileSync(this.options.markerPath, "");
			} catch (error) {
				console.warn("desktop tray: could not record background confirmation", error);
			}
			hide();
		} catch (error) {
			console.warn("desktop tray: background confirmation unavailable", error);
		} finally {
			this.pending = false;
		}
	}
};
//#endregion
//#region lib/types/main.js
/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */
let focusPrimaryWindow = () => {};
let stopForRecovery = async () => {
	await stopOperationReports();
};
let shuttingDown = false;
/**
* Set by quit entries that must not ask: crash recovery exit and restart, and the
* development restart command. The installer handoff has its own before-quit branch.
*/
let skipQuitConfirmation = false;
let windowsLanguage = readDesktopLocaleCache(app.getPath("userData"));
/**
* Whether the backend has reached ready: false until the first ready, back to
* false when a restart returns it to starting, frozen during shutdown so a
* failure while tearing down a ready backend still reads as `running`.
*/
let backendReady = false;
/** Error-level console output of the primary window, attached to crash reports. */
const rendererConsole = new RendererConsoleTail();
app.setAppLogsPath();
function currentDesktopLocale() {
	return resolveDesktopLocale(windowsLanguage ?? app.getLocale());
}
/** Quit without the task confirmation; the caller has already decided the application must stop. */
function quitWithoutConfirmation() {
	skipQuitConfirmation = true;
	app.quit();
}
const recovery = new DesktopFatalRecovery({
	messages: () => currentDesktopLocale().messages,
	show: (options) => dialog.showMessageBox(options),
	stop: () => {
		shuttingDown = true;
		return stopForRecovery();
	},
	disablePlugins: async () => {
		const backupPath = await new DesktopProjectManager(resolveDesktopPaths(), runtimeResources()).disableAllPlugins();
		console.info("Desktop profile recovery completed:", {
			profilePatchBackup: backupPath ?? null,
			homePatch: "unchanged"
		});
	},
	exit: () => {
		quitWithoutConfirmation();
	},
	restart: () => {
		app.relaunch();
		quitWithoutConfirmation();
	},
	writeReport: (error, source) => persistCrashReport(error, source),
	revealReport: async (path) => {
		await access(path);
		shell.showItemInFolder(path);
	}
});
let operationJournal;
let operationReportJob;
let operationReportAbort;
let operationReportsStopping = false;
let operationReportStop;
/** Bound application shutdown waiting without claiming that an unresponsive Worker has exited. */
function stopOperationReports() {
	operationReportStop ??= waitForOperationReports();
	return operationReportStop;
}
async function waitForOperationReports() {
	operationReportsStopping = true;
	operationReportAbort?.abort();
	const job = operationReportJob;
	if (job === void 0) return;
	let timer;
	try {
		if (!await Promise.race([job.then(() => true), new Promise((resolve) => {
			timer = setTimeout(() => {
				resolve(false);
			}, 500);
		})])) console.error("dsh desktop: operation report Worker has not exited; continuing shutdown");
	} finally {
		clearTimeout(timer);
	}
}
function persistCrashReport(error, source) {
	const report = writeCrashReport(app.getPath("logs"), {
		operationHistoryPlanned: !shuttingDown && !operationReportsStopping,
		source,
		phase: backendReady ? "running" : "startup",
		error,
		...error instanceof DesktopHostFatalError && error.diagnostic !== void 0 ? { hostDiagnostic: error.diagnostic } : {},
		rendererConsole: rendererConsole.snapshot(),
		app: {
			name: app.name,
			version: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			electron: process.versions.electron,
			node: process.versions.node,
			locale: currentDesktopLocale().id
		},
		time: /* @__PURE__ */ new Date()
	});
	report.then((path) => {
		if (path !== void 0 && operationReportJob === void 0 && !shuttingDown && !operationReportsStopping) {
			operationReportAbort = new AbortController();
			operationReportJob = runOperationReportJob({
				reportPath: path,
				directory: join(app.getPath("userData"), "plugin-operations"),
				limits: {
					bytes: 64 * 1024,
					recordBytes: 4096,
					records: 100,
					outputBytes: 64 * 1024
				},
				journal: operationJournal?.status() ?? null
			}, {
				timeoutMs: 500,
				cancellationGraceMs: 100
			}, operationReportAbort.signal);
			operationReportJob.finally(() => {
				operationReportJob = void 0;
				operationReportAbort = void 0;
			});
		}
	}).catch((_error) => {});
	return report;
}
function reportFatal(error, source) {
	console.error(error);
	if (shuttingDown) {
		persistCrashReport(error, source);
		return;
	}
	recovery.report(error, source).catch(async (failure) => {
		console.error(failure);
		shuttingDown = true;
		await stopOperationReports();
		app.exit(1);
	});
}
protocol.registerSchemesAsPrivileged([{
	scheme: SCHEME,
	privileges: {
		standard: true,
		secure: true,
		supportFetchAPI: true,
		corsEnabled: true,
		stream: true,
		codeCache: true
	}
}]);
function runtimeResources() {
	const development = !app.isPackaged;
	return {
		node: process.execPath,
		nodeBin: development ? join(app.getAppPath(), "scripts", "node-bin") : join(process.resourcesPath, "runtime", "bin"),
		pnpm: (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : void 0) ?? (development ? join(app.getAppPath(), "node_modules", "pnpm", "bin", "pnpm.mjs") : join(process.resourcesPath, "runtime", "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs")),
		dsh: (development ? process.env.DSH_DESKTOP_DSH_DIR : void 0) ?? (development ? join(app.getAppPath(), ".desktop-build", "development", "project") : join(app.getAppPath(), "dsh"))
	};
}
function developmentPrimaryRuntime() {
	const directory = process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR;
	if (directory === void 0 || directory === "") throw new Error("dsh desktop: DSH_DESKTOP_PRIMARY_RUNTIME_DIR is required for an unpackaged launch");
	return directory;
}
function developmentHostInspectPort(enabled) {
	const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT;
	if (!enabled || configured === void 0 || configured === "") return void 0;
	const port = Number(configured);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535");
	return port;
}
/**
* Opaque chrome fallback matching the built-in sidebar palette (the resolved
* `--dsw-static-neutral-bluish-900` / `-50` tokens). An approximation for
* custom themes: Windows captions use the renderer's measured palette over
* windowsAppearance IPC. The Windows workspace base stays opaque and follows
* the effective light/dark theme; macOS uses it only while minimized or hidden.
* @returns the sidebar fill hex for the effective application color scheme.
*/
function chromeFallbackFill() {
	return nativeTheme.shouldUseDarkColors ? "#1b1b1c" : "#f9fafb";
}
/**
* Add the effective Desktop palette to a Platform authorization URL so the
* login page opens in the application's theme. `system` resolves through
* `nativeTheme.shouldUseDarkColors`, which follows the theme source the
* application preload publishes.
* @param authorizeUrl - validated Platform authorization URL.
* @returns the authorization URL carrying `theme=light` or `theme=dark`.
*/
function platformLoginUrl(authorizeUrl) {
	const url = new URL(authorizeUrl);
	url.searchParams.set("theme", nativeTheme.shouldUseDarkColors ? "dark" : "light");
	return url.href;
}
function createWindow(preload, show = false, primary = false) {
	const window = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 520,
		minHeight: 600,
		show,
		...process.platform === "win32" && primary ? {
			backgroundColor: chromeFallbackFill(),
			titleBarStyle: "hidden",
			titleBarOverlay: {
				height: 40,
				color: chromeFallbackFill(),
				symbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115"
			}
		} : {},
		...process.platform === "darwin" ? {
			titleBarStyle: "hiddenInset",
			trafficLightPosition: {
				x: 16,
				y: 18
			},
			vibrancy: "sidebar",
			visualEffectState: "active",
			backgroundColor: "#00000000"
		} : {},
		webPreferences: {
			preload,
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webSecurity: true,
			webviewTag: primary,
			devTools: true
		}
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);
		return { action: "deny" };
	});
	if (process.platform === "darwin" || process.platform === "win32") {
		const sendFullscreen = () => {
			if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.windowFullscreen, window.isFullScreen());
		};
		window.on("enter-full-screen", sendFullscreen);
		window.on("leave-full-screen", sendFullscreen);
		window.webContents.on("did-finish-load", sendFullscreen);
	}
	if (process.platform === "win32" && primary) {
		const updateBackground = () => {
			if (!window.isDestroyed()) window.setBackgroundColor(chromeFallbackFill());
		};
		nativeTheme.on("updated", updateBackground);
		window.once("closed", () => {
			nativeTheme.removeListener("updated", updateBackground);
		});
	}
	if (process.platform === "darwin") {
		const applyBackdrop = () => {
			if (window.isDestroyed()) return;
			if (window.isMinimized() || !window.isVisible()) {
				window.setVibrancy(null);
				window.setBackgroundColor(chromeFallbackFill());
			} else {
				window.setVibrancy("sidebar");
				window.setBackgroundColor("#00000000");
			}
		};
		window.on("minimize", applyBackdrop);
		window.on("hide", applyBackdrop);
		window.on("restore", applyBackdrop);
		window.on("show", applyBackdrop);
	}
	window.webContents.on("context-menu", (_event, { isEditable, selectionText, editFlags }) => {
		const items = [];
		if (isEditable) items.push({
			role: "undo",
			enabled: editFlags.canUndo
		}, {
			role: "redo",
			enabled: editFlags.canRedo
		}, { type: "separator" }, {
			role: "cut",
			enabled: editFlags.canCut
		}, {
			role: "copy",
			enabled: editFlags.canCopy
		}, {
			role: "paste",
			enabled: editFlags.canPaste
		}, { type: "separator" }, {
			role: "selectAll",
			enabled: editFlags.canSelectAll
		});
		else if (selectionText.length > 0) items.push({
			role: "copy",
			enabled: editFlags.canCopy
		});
		if (items.length > 0) {
			const messages = currentDesktopLocale().messages;
			Menu.buildFromTemplate(items.map((item) => ({
				...item,
				...process.platform === "win32" && item.role !== void 0 && item.role in messages ? { label: messages[item.role] } : {},
				accelerator: ""
			}))).popup({ window });
		}
	});
	window.webContents.on("will-navigate", (event, url) => {
		const destination = new URL(url);
		const current = new URL(window.webContents.getURL());
		if (destination.protocol !== `dsh-app:` && !(destination.protocol === "http:" && destination.origin === current.origin)) {
			event.preventDefault();
			if (["http:", "https:"].includes(destination.protocol)) shell.openExternal(url);
		}
	});
	return window;
}
async function main() {
	const desktopSettings = await readDesktopSettings(app.getPath("userData"));
	pruneCrashReports(app.getPath("logs"));
	const journalDirectory = process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR;
	const updateJournal = journalDirectory === void 0 ? void 0 : new DesktopUpdateJournal(journalDirectory, app.getVersion());
	const resources = runtimeResources();
	const paths = resolveDesktopPaths();
	const development = !app.isPackaged;
	const primaryRuntime = development ? developmentPrimaryRuntime() : join(process.resourcesPath, "runtime", "primary-runtime");
	const activeProject = paths.profile;
	const manager = new DesktopProjectManager(paths, resources);
	const loginShellRead = new AbortController();
	app.on("will-quit", () => {
		loginShellRead.abort();
	});
	const loginShell = readDesktopLoginShellEnvironment(process.env, resolveDesktopLoginShellConfig(process.env), { signal: loginShellRead.signal }).then((result) => {
		for (const failure of result.failures) console.warn(`desktop login shell: ${failure.shell} failed (${failure.reason})`);
		return result.environment;
	});
	let hostEnvironment = process.env;
	const prepareHostEnvironment = async () => {
		hostEnvironment = await loginShell;
	};
	let quitting = false;
	let startup;
	let workspaceRecovery;
	let mainWindow;
	let welcomeWindow;
	const installFileDrag = () => installDesktopFileDrag((event) => assertProductSender(event), (address, signal) => {
		const host = backend.host;
		if (host === void 0) return Promise.reject(/* @__PURE__ */ new Error("File drag Host unavailable"));
		return host.resolveDragResource(address, signal);
	});
	const fileDragCleanups = new Set([installFileDrag()]);
	let fileDragStopped = false;
	const disposeFileDrag = async () => {
		fileDragStopped = true;
		const failure = (await Promise.allSettled([...fileDragCleanups].map(async (release) => {
			await release();
			fileDragCleanups.delete(release);
		}))).find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	};
	let enteredWorkspace = false;
	let raiseAfterUpdate = process.platform === "win32" && process.argv.includes("--updated");
	let shellInstallerOwnsQuit = false;
	let requireCleanStop = false;
	let updateStoppedHost = false;
	let updateStopFailure;
	let updateState = { phase: "idle" };
	let channelState;
	const updatePresentation = (state) => ({
		...presentDesktopUpdate(state),
		...channelState?.error === void 0 ? {} : { configurationError: channelState.error }
	});
	const systemLanguages = app.getPreferredSystemLanguages();
	let locale = windowsLanguage === void 0 ? resolveDesktopStartupLocale(null, systemLanguages) : resolveDesktopLocale(windowsLanguage);
	windowsLanguage = locale.id;
	let mandatoryPolicy;
	let mandatoryUI;
	let policyAuth;
	let tray;
	/**
	* The operating system is ending the session: the quit skips its confirmation. Windows sets it
	* on the definitive session-end message. macOS sets it on the power-off notification, which
	* another application can still cancel, so the next focus or show of the main window clears it.
	*/
	let sessionEnding = false;
	const isQuitting = () => quitting;
	const currentMainWindow = () => mainWindow;
	const ordinaryDialogs = /* @__PURE__ */ new Set();
	const currentDialogWindow = () => welcomeWindow ?? mainWindow;
	const updateOverlays = new DesktopUpdateOverlays();
	const updateDialog = new DesktopUpdateDialog(fileURLToPath(new URL("./preload-update-dialog.cjs", import.meta.url)), () => locale, updateOverlays);
	const isMandatory = () => mandatoryPolicy?.state.blocking === true;
	const ordinaryMessageBox = async (options, parent = currentDialogWindow()) => {
		const controller = new AbortController();
		ordinaryDialogs.add(controller);
		try {
			if (parent === void 0) return {
				response: options.cancelId ?? 0,
				checkboxChecked: false
			};
			return await updateDialog.show(parent, {
				...options,
				signal: controller.signal
			});
		} finally {
			ordinaryDialogs.delete(controller);
		}
	};
	const showAbout = async () => {
		await ordinaryMessageBox({
			type: "info",
			title: locale.messages.aboutMenu,
			message: locale.messages.aboutProduct,
			detail: formatDesktopMessage(locale.messages.aboutVersion, { version: app.getVersion() }),
			buttons: [locale.messages.updateAcknowledge],
			cancelId: 0
		});
	};
	const commandManager = new DesktopCommandManager({
		resources: process.resourcesPath,
		isPackaged: app.isPackaged,
		isInstalledLocation: () => process.platform !== "darwin" || app.isInApplicationsFolder(),
		isInstalling: () => updateState.phase === "installing",
		isQuitting,
		messages: () => currentDesktopLocale().messages,
		show: ordinaryMessageBox
	});
	const appPreload = fileURLToPath(new URL("./preload-app.cjs", import.meta.url));
	const applicationUrl = `${SCHEME}://app/`;
	let hostUrl;
	let hostCookie;
	const browserGuests = new DesktopBrowserGuests(() => hostUrl);
	let injections = [];
	let welcomeBackend;
	let reportedLaunch = false;
	let analyticsEnabled = false;
	const track = async (eventName, attributes) => {
		const event = {
			eventName,
			attributes,
			timestamp: Date.now()
		};
		try {
			if (analyticsEnabled) await welcomeBackend?.report(event);
		} catch (_error) {}
	};
	let stopAccount;
	let openedAttempt;
	let returnedAttempt;
	let pendingWelcomeNotice;
	let previousAccountStatus;
	const assertProductSender = (event) => {
		assertDesktopSender(event, ["app"]);
		if (mainWindow === void 0 || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame === null || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("dsh desktop: rejected IPC from an unowned renderer");
		return mainWindow;
	};
	let navigation;
	const navigateMain = (url) => {
		const window = mainWindow;
		if (quitting || window === void 0 || window.isDestroyed()) return Promise.resolve();
		if (navigation?.window === window && navigation.url === url) return navigation.promise;
		const next = {
			window,
			url,
			promise: Promise.resolve()
		};
		next.promise = window.loadURL(url).catch((error) => {
			if (quitting || shuttingDown || window.isDestroyed() || navigation !== next || error instanceof Error && "code" in error && error.code === "ERR_ABORTED") return;
			navigation = void 0;
			throw error;
		});
		navigation = next;
		return next.promise;
	};
	const platformView = new DesktopPlatformView(join(app.getAppPath(), "lib", "preload-platform-account.cjs"), () => locale.id === "zh-CN" ? "zh_CN" : "en_US", process.platform === "win32" ? "win32" : "darwin", (owner) => isMandatory() || updateOverlays.input(owner).blocked);
	const backend = new DesktopBackendController((onFailure) => {
		const hostInspectPort = developmentHostInspectPort(development);
		const host = new DesktopHostProcess(resources.node, resources.dsh, activeProject, hostInspectPort, {
			...hostEnvironment,
			DSH_CLIENT_VERSION: desktopClientVersion()
		}, onFailure, primaryRuntime, resources, (next) => {
			platformView.setSession(next);
		}, (record) => {
			operationJournal ??= new OperationJournal(join(app.getPath("userData"), "plugin-operations"), {
				segmentBytes: 256 * 1024,
				recordBytes: 4096,
				queuedBytes: 64 * 1024
			});
			operationJournal.enqueue(JSON.stringify(record));
		});
		return {
			start: async () => {
				const ready = await host.start();
				const cookie = await authenticateWebHost(ready.url);
				hostCookie = cookie;
				hostUrl = ready.url;
				removeLegacyHostCookies(session.defaultSession.cookies, ready.url).catch((error) => {
					console.error("desktop: legacy Host cookie cleanup failed", error);
				});
				if (ready.injections === void 0) throw new Error("Desktop Host did not provide boot injections");
				injections = ready.injections;
				welcomeBackend = connectDesktopWelcome(ready.url, cookie);
				analyticsEnabled = await welcomeBackend.analyticsEnabled().catch(() => false);
				if (!reportedLaunch) {
					reportedLaunch = true;
					track("desktop_app_launch", {});
				}
				stopAccount?.();
				const accountBackend = welcomeBackend.account;
				stopAccount = accountBackend.watch((state) => {
					if (quitting) return;
					if (welcomeWindow !== void 0 && !welcomeWindow.isDestroyed()) welcomeWindow.webContents.send(WELCOME_IPC.state, state);
					const attempt = state.attempt;
					if (attempt?.phase === "waiting-browser" && attempt.authorizeUrl !== void 0 && openedAttempt !== attempt.id) {
						openedAttempt = attempt.id;
						shell.openExternal(platformLoginUrl(attempt.authorizeUrl)).catch(() => void 0);
					}
					if ((attempt?.phase === "failed" || attempt?.phase === "expired") && returnedAttempt !== attempt.id) {
						returnedAttempt = attempt.id;
						focusPrimaryWindow();
					}
					if (state.status === "credential-stored" && attempt?.phase === "succeeded" && welcomeWindow !== void 0) enterWorkspace({ activate: false }).catch(() => void 0);
					if (previousAccountStatus === "credential-stored" && state.status === "signed-out") readWelcomeState().then(async (value) => {
						if (needsWelcome(value) && !quitting) {
							enteredWorkspace = false;
							await showWelcome();
							if (welcomeWindow !== void 0 && !welcomeWindow.isDestroyed()) welcomeWindow.webContents.send(WELCOME_IPC.state, state);
						}
					}).catch(() => void 0);
					previousAccountStatus = state.status;
				}, () => {}, () => {
					readWelcomeState().then(async (value) => {
						if (!needsWelcome(value) || quitting) return;
						pendingWelcomeNotice = "session-expired";
						enteredWorkspace = false;
						await showWelcome();
						const state = await accountBackend.state();
						if (welcomeWindow !== void 0 && !welcomeWindow.isDestroyed()) welcomeWindow.webContents.send(WELCOME_IPC.state, state);
					}).catch(() => void 0);
				}, (enabled) => {
					analyticsEnabled = enabled;
				});
			},
			stop: async () => {
				analyticsEnabled = false;
				stopAccount?.();
				try {
					await host.stop(requireCleanStop);
				} catch (error) {
					if (!requireCleanStop || !(error instanceof DesktopHostUncleanExitError)) throw error;
					updateStopFailure = error;
				}
			},
			updateTasks: (action) => host.updateTasks(action),
			inspectQuit: () => host.inspectQuit(),
			resolveDragResource: (address, signal) => host.resolveDragResource(address, signal)
		};
	}, (state) => {
		if (state.phase === "error") reportFatal(state.failure, "host");
		else if (!shuttingDown) backendReady = state.phase === "ready";
	});
	const updateErrors = /* @__PURE__ */ new WeakMap();
	const showUpdateFailure = (state) => {
		if (state.phase !== "error") return Promise.resolve();
		if (isMandatory()) {
			mandatoryUI?.sync();
			return Promise.resolve();
		}
		let shown = updateErrors.get(state);
		if (shown === void 0) {
			shown = ordinaryMessageBox({
				type: "error",
				title: locale.messages.updateFailedTitle,
				message: desktopUpdateErrorSummary(state, locale.messages),
				technicalDetails: state.technicalDetails ?? state.message ?? ""
			}).then(() => {});
			updateErrors.set(state, shown);
		}
		return shown;
	};
	const publishUpdate = (state) => {
		updateJournal?.state(state);
		updateState = state;
		mandatoryUI?.sync();
		for (const window of BrowserWindow.getAllWindows()) window.webContents.send(DESKTOP_IPC.updatesPresentation, updatePresentation(state));
		if (state.phase === "error" && state.failedOperation !== "check" && state.failedOperation !== "configuration") {
			if (state.failedOperation === "install" && fileDragStopped && !quitting) {
				fileDragCleanups.add(installFileDrag());
				fileDragStopped = false;
			}
			const restoreHost = state.failedOperation === "install" && updateStoppedHost && !quitting;
			if (state.failedOperation === "install" && !quitting) {
				operationReportsStopping = shuttingDown;
				operationReportStop = void 0;
			}
			shellInstallerOwnsQuit = false;
			updateStoppedHost = false;
			if (restoreHost) {
				const hostReady = backend.start(prepareHostEnvironment);
				startup = hostReady;
				const recovery = hostReady.then(async () => {
					if (quitting) return;
					navigation = void 0;
					await navigateMain(applicationUrl);
					if (backend.host !== void 0) updateJournal?.action("workspace-ready");
				});
				workspaceRecovery = recovery;
				recovery.catch((error) => {
					reportFatal(error, "main");
				}).finally(() => {
					if (startup === hostReady) startup = void 0;
					if (workspaceRecovery === recovery) workspaceRecovery = void 0;
				});
			}
			showUpdateFailure(state).catch((error) => {
				console.error(error);
			});
		}
		return state;
	};
	const readWelcomeState = async () => {
		if (backend.host === void 0 || welcomeBackend === void 0) throw new Error("desktop welcome: backend unavailable");
		return welcomeBackend.read();
	};
	stopForRecovery = async () => {
		const reports = stopOperationReports();
		try {
			await backend.close();
		} finally {
			await Promise.all([operationJournal?.drain(500), reports]);
		}
	};
	const reconcileBackend = () => {
		startup ??= (async () => {
			await navigateMain(applicationUrl);
			await backend.start(async () => {
				await Promise.all([manager.applyRelease(), prepareHostEnvironment()]);
			});
			if (backend.host !== void 0) await openInitialWindow();
			if (backend.host !== void 0) updateJournal?.action("workspace-ready");
		})().catch((error) => {
			updateJournal?.action("workspace-failed");
			reportFatal(error, "main");
			throw error;
		}).finally(() => {
			startup = void 0;
		});
		return startup;
	};
	const manifest = JSON.parse(await readFile$1(join(app.getAppPath(), "package.json"), "utf8"));
	const packagedChannel = desktopUpdateChannel(manifest);
	const channelSettings = new DesktopUpdateSettings(app.getPath("userData"), packagedChannel);
	const initialChannel = await channelSettings.load();
	channelState = {
		channel: initialChannel.kind === "ready" ? initialChannel.channel : null,
		packagedChannel,
		changing: false,
		...initialChannel.kind === "error" ? { error: configurationFailure(initialChannel.error) } : {}
	};
	const updates = new DesktopUpdateCoordinator(publishUpdate, async () => {
		await commandManager.idle();
		await workspaceRecovery;
		await startup?.catch(() => void 0);
		const host = backend.host;
		if (host === void 0) throw new DesktopUpdatePreparationError("tasks-unavailable", locale.messages.updateTasksUnavailable);
		const active = await host.updateTasks("inspect");
		const parent = currentDialogWindow();
		if (parent === void 0 || !await prepareDesktopUpdateWindow(parent, locale.messages.updateFullscreenTimeout)) return false;
		const ready = desktopUpdateReadyConfirmation(locale.messages, updates.state.version ?? "", process.platform);
		const confirmation = {
			type: active ? "warning" : "info",
			title: locale.messages.updateTitle,
			message: active ? locale.messages.updateActiveTasks : ready.message,
			detail: active ? locale.messages.updateActiveTasksDetail : ready.detail,
			buttons: active ? [locale.messages.updateStopTasks, locale.messages.updateLater] : [locale.messages.installAndRestart],
			defaultId: 1,
			cancelId: 1
		};
		if (isMandatory()) {
			if (!await mandatoryUI?.confirm(updates.state.version ?? "", active)) return false;
		} else if ((await updateDialog.show(parent, confirmation)).response !== 0 || isMandatory()) return false;
		await track("desktop_upgrade_install_restart_click", {});
		if (backend.host !== host) throw new DesktopUpdatePreparationError("tasks-unavailable", locale.messages.updateTasksUnavailable);
		try {
			const stillActive = await host.updateTasks("lock");
			if (stillActive && !active) throw new DesktopUpdatePreparationError("tasks-changed", locale.messages.updateTasksChanged);
			mandatoryUI?.preparingRestart(stillActive);
			await platformView.closeAndWait();
			await disposeFileDrag().catch((error) => {
				console.error(error);
			});
			requireCleanStop = true;
			updateStopFailure = void 0;
			await Promise.all([backend.stop(), stopOperationReports()]);
			updateStoppedHost = true;
			const stopFailure = updateStopFailure;
			if (stopFailure !== void 0) throw new DesktopUpdatePreparationError("stop-failed", locale.messages.updateStopFailed, stopFailure.message);
			await operationJournal?.drain(500);
			updateJournal?.action("install-confirmed");
			shellInstallerOwnsQuit = true;
		} catch (error) {
			operationReportsStopping = shuttingDown;
			operationReportStop = void 0;
			if (!updateStoppedHost) await host.updateTasks("unlock").catch((unlockError) => {
				console.error(unlockError);
			});
			throw error;
		} finally {
			requireCleanStop = false;
		}
		return true;
	}, void 0, void 0, void 0, (success, reason) => {
		track("desktop_upgrade_download_result", {
			is_success: success,
			...reason === void 0 ? {} : { error_reason: reason }
		});
	}, initialChannel.kind === "ready" ? initialChannel.channel : packagedChannel);
	if (initialChannel.kind === "error") updates.suspendConfiguration(initialChannel.error.path);
	const publishChannel = (state) => {
		channelState = state;
		for (const window of BrowserWindow.getAllWindows()) {
			window.webContents.send(DESKTOP_IPC.updatesChannelChanged, state);
			window.webContents.send(DESKTOP_IPC.updatesPresentation, updatePresentation(updates.state));
		}
		return state;
	};
	const updateSchedule = new DesktopUpdateSchedule(updates, resolveDesktopUpdateScheduleConfig(process.env));
	const downloadUpdate = async (version, revision = updates.revision) => {
		track("desktop_upgrade_click", {});
		updateJournal?.action("download-requested");
		const state = await updates.download(version, revision);
		if (state.phase !== "ready" || quitting) return state;
		if (!isMandatory()) await windowShown();
		if (quitting) return state;
		return updates.install(version, revision);
	};
	const windowShown = () => new Promise((resolve) => {
		const window = currentDialogWindow();
		if (window === void 0 || window.isDestroyed() || window.isVisible()) {
			resolve();
			return;
		}
		window.once("show", () => {
			resolve();
		});
		window.once("closed", () => {
			resolve();
		});
	});
	protocol.handle(SCHEME, (request) => {
		const url = new URL(request.url);
		if (url.hostname === "shell") return serveWebDocument(request, join(app.getAppPath(), url.pathname === "/design-platform.css" ? "lib/welcome" : "renderer"));
		if (url.hostname === "app") {
			if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/assets/") || ["/favicon.svg", "/manifest.webmanifest"].includes(url.pathname)) return serveWebDocument(request, join(resources.dsh, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist"));
			if (backend.host === void 0 || hostUrl === void 0 || hostCookie === void 0) return Promise.resolve(new Response(null, { status: 503 }));
			return forwardWebRequest(request, hostUrl, hostCookie);
		}
		return Promise.resolve(new Response(null, { status: 404 }));
	});
	installDesktopDirectoryPicker(() => mainWindow);
	installMicrophonePermissions(session.defaultSession, () => mainWindow?.webContents);
	const shortcuts = installDesktopShortcuts(() => mainWindow, app.getPath("userData"), process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux", () => {
		refreshApplicationMenu();
	}, (window) => updateOverlays.input(window));
	app.on("will-quit", () => {
		shortcuts.dispose();
	});
	ipcMain.handle(DESKTOP_IPC.boot, async (event) => {
		assertDesktopSender(event, ["app"]);
		await startup;
		if (backend.host === void 0 || hostUrl === void 0) throw new Error("Desktop Host is unavailable");
		return {
			injections,
			streamBaseUrl: new URL(hostUrl).origin
		};
	});
	ipcMain.handle(DESKTOP_IPC.bootFailed, (event, message) => {
		assertDesktopSender(event, ["app"]);
		if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("dsh desktop: rejected startup failure from a non-primary frame");
		if (typeof message !== "string") throw new Error("dsh desktop: startup failure must be text");
		reportFatal(new Error(message), "web-boot");
	});
	ipcMain.handle(DESKTOP_IPC.browserAcquire, (event, workspace) => {
		assertProductSender(event);
		return browserGuests.acquire(event.sender, workspace);
	});
	ipcMain.handle(DESKTOP_IPC.browserRelease, (event, lease) => {
		assertProductSender(event);
		return browserGuests.release(event.sender, lease);
	});
	session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["ws://127.0.0.1/*", "wss://127.0.0.1/*"] }, (details, callback) => {
		if (hostUrl === void 0 || hostCookie === void 0 || details.webContentsId !== mainWindow?.webContents.id) {
			callback({});
			return;
		}
		const target = new URL(hostUrl);
		const requested = new URL(details.url);
		if (requested.host !== target.host || requested.protocol !== (target.protocol === "https:" ? "wss:" : "ws:")) {
			callback({});
			return;
		}
		const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]));
		if (headers.origin !== "dsh-app://app") {
			callback({ cancel: true });
			return;
		}
		callback({ requestHeaders: {
			...headers,
			origin: target.origin,
			cookie: hostCookie,
			"sec-fetch-site": "same-origin"
		} });
	});
	const assertMainApplication = (event) => {
		const owner = mainWindow;
		if (owner === void 0 || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame || !event.senderFrame.url.startsWith("dsh-app://app/")) throw new Error("Rejected Platform command");
		return owner;
	};
	installFileActions(assertMainApplication, () => hostUrl);
	ipcMain.on(PLATFORM_IPC.bootstrap, (event) => {
		try {
			event.returnValue = platformView.bootstrap(event);
		} catch {
			event.returnValue = null;
		}
	});
	ipcMain.handle(PLATFORM_IPC.open, (event, page, bounds) => {
		const owner = assertMainApplication(event);
		if (page !== "usage" && page !== "top-up") throw new Error("Invalid Platform page");
		return platformView.open(owner, page, platformBounds(bounds));
	});
	ipcMain.handle(PLATFORM_IPC.bounds, (event, bounds) => {
		assertMainApplication(event);
		platformView.setBounds(platformBounds(bounds));
	});
	ipcMain.handle(PLATFORM_IPC.close, (event) => {
		assertMainApplication(event);
		platformView.close();
	});
	ipcMain.on(DESKTOP_IPC.nativeThemeSet, (event, source) => {
		if (mainWindow === void 0 || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !event.senderFrame.url.startsWith(`dsh-app://app/`)) return;
		if (source !== "light" && source !== "dark" && source !== "system") return;
		nativeTheme.themeSource = source;
	});
	ipcMain.handle(DESKTOP_IPC.localeBootstrap, async (event) => {
		if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || new URL(event.senderFrame.url).origin !== new URL(applicationUrl).origin) throw new Error("desktop welcome: rejected locale request from an unowned frame");
		if (welcomeBackend === void 0) throw new Error("desktop welcome: backend unavailable");
		return {
			languages: systemLanguages,
			preference: await welcomeBackend.readLocalePreference()
		};
	});
	ipcMain.on(DESKTOP_IPC.localeChanged, (event, next) => {
		const window = mainWindow;
		if (window === void 0 || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || typeof next !== "string") return;
		const current = resolveDesktopStartupLocale(next, systemLanguages);
		writeDesktopLocaleCache(app.getPath("userData"), current.id);
		if (current.id === locale.id) return;
		locale = current;
		platformView.notifyLocaleChanged();
		windowsLanguage = locale.id;
		refreshApplicationMenu();
	});
	ipcMain.handle(DESKTOP_IPC.updatesChannelGet, (event) => {
		assertProductSender(event);
		return channelState;
	});
	let channelRequests = 0;
	ipcMain.handle(DESKTOP_IPC.updatesChannelSet, async (event, channel) => {
		assertProductSender(event);
		if (!isDesktopUpdateChannel(channel)) throw new Error("desktop update: unsupported channel");
		if (channelState === void 0) throw new Error("desktop update: settings are not initialized");
		channelRequests++;
		publishChannel({
			...channelState,
			changing: true
		});
		try {
			const kind = await updates.switchChannel(channel, async () => {
				try {
					await channelSettings.save(channel);
				} catch (error) {
					if (channelSaveFailure(error) === "uncertain") {
						updates.suspendConfiguration("desktop update: settings save outcome is unknown");
						publishChannel({
							channel: updates.selectedChannel,
							packagedChannel,
							changing: true,
							error: "read"
						});
					}
					throw error;
				}
			});
			if (kind === "applied") mandatoryPolicy?.check("channel-change", true).catch((error) => {
				console.error(error);
			});
			return {
				kind,
				state: publishChannel({
					channel: updates.selectedChannel,
					packagedChannel,
					changing: --channelRequests > 0
				})
			};
		} catch (error) {
			console.error("desktop update: channel change failed", error);
			return {
				kind: "failed",
				state: publishChannel({
					...channelState,
					changing: --channelRequests > 0,
					...updates.configurationFailure === "cleanup" ? { error: "cleanup" } : {}
				}),
				reason: channelSaveFailure(error)
			};
		}
	});
	ipcMain.handle(DESKTOP_IPC.updatesStatus, (event) => {
		assertProductSender(event);
		return updatePresentation(updates.state);
	});
	ipcMain.handle(DESKTOP_IPC.deviceInfo, (event) => {
		assertProductSender(event);
		return readDeviceInfo();
	});
	ipcMain.handle(DESKTOP_IPC.onboardingApiKey, async (event) => {
		assertProductSender(event);
		return (await readWelcomeState()).hasApiKey;
	});
	ipcMain.on(DESKTOP_IPC.onboardingActive, (event, active) => {
		const window = mainWindow;
		if (window === void 0 || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame.url.startsWith(`dsh-app://app/`) || typeof active !== "boolean") return;
		window.setMinimumSize(active ? 960 : 520, 600);
		if (active) {
			const { width, height } = window.getBounds();
			if (width < 960) window.setSize(960, height);
		}
	});
	ipcMain.handle(DESKTOP_IPC.updatesOpen, async (event) => {
		assertProductSender(event);
		await openUpdatePrompt();
	});
	let configurationPrompt;
	const showConfigurationError = () => {
		configurationPrompt ??= Promise.resolve().then(async () => {
			while (channelState?.error !== void 0) if ((await ordinaryMessageBox({
				type: "error",
				title: locale.messages.updateFailedTitle,
				message: configurationMessage(channelState.error, locale.messages),
				detail: channelSettings.path,
				buttons: [
					locale.messages.updateReloadSettings,
					locale.messages.updateShowSettingsFile,
					locale.messages.updateClose
				],
				defaultId: 0,
				cancelId: 2,
				keepOpenAction: {
					index: 1,
					run: () => {
						shell.showItemInFolder(channelSettings.path);
					}
				},
				action: {
					index: 0,
					run: async () => {
						if (channelRequests > 0 || channelState === void 0) return false;
						channelRequests++;
						publishChannel({
							...channelState,
							changing: true
						});
						try {
							const loaded = await channelSettings.load();
							if (loaded.kind === "error") {
								publishChannel({
									...channelState,
									changing: true,
									error: configurationFailure(loaded.error)
								});
								return false;
							}
							await updates.switchChannel(loaded.channel, async () => {});
							publishChannel({
								channel: updates.selectedChannel,
								packagedChannel,
								changing: true
							});
							return true;
						} catch (error) {
							console.error("desktop update: settings reload failed", error);
							publishChannel({
								...channelState,
								...updates.configurationFailure === "cleanup" ? { error: "cleanup" } : {}
							});
							return false;
						} finally {
							publishChannel({
								...channelState,
								changing: --channelRequests > 0
							});
						}
					}
				}
			}, mandatoryUI?.confirmationWindow ?? currentDialogWindow())).response !== 0) return;
		}).finally(() => {
			configurationPrompt = void 0;
		});
		return configurationPrompt;
	};
	let promptOperation;
	let policyAuthenticationQueued = false;
	/** Present check results only while their captured channel revision remains current. */
	const openUpdatePrompt = (manual = false) => {
		if (channelState?.error !== void 0) return showConfigurationError();
		if (authenticationOperation !== void 0) {
			policyAuth?.focus();
			updateDialog.focus();
		}
		if (!isMandatory() && (updates.state.phase === "downloading" || updates.state.phase === "verifying")) {
			if (updateDialog.isOpen) {
				updateDialog.focus();
				return Promise.resolve();
			}
			const options = {
				type: "info",
				title: locale.messages.updateCheckTitle,
				message: updates.state.phase === "downloading" ? locale.messages.updateDownloadInProgress : locale.messages.updateVerifying,
				detail: updates.state.phase === "downloading" ? locale.messages.updateDownloadDetail : "",
				buttons: [locale.messages.updateClose],
				cancelId: 0
			};
			return ordinaryMessageBox(options).then(() => {}).catch(async (error) => {
				console.error(error);
				try {
					await dialog.showMessageBox(options);
				} catch (nativeError) {
					console.error(nativeError);
				}
			});
		}
		let failedOperation = "check";
		promptOperation ??= Promise.resolve().then(async () => {
			if (manual) updateJournal?.action("check-requested");
			const joinedPolicyAuthentication = authenticationOperation !== void 0;
			if (joinedPolicyAuthentication) await authenticatePolicy();
			if (isMandatory()) {
				mandatoryUI?.focus();
				if (manual) await Promise.all([checkPolicyManually(), updateSchedule.check(true)]);
				return;
			}
			let controller;
			let progress;
			try {
				let state = updates.state;
				const revision = updates.revision;
				if (manual || state.phase === "idle" || state.phase === "error" && state.failedOperation === "check") {
					controller = new AbortController();
					ordinaryDialogs.add(controller);
					const parent = currentDialogWindow();
					progress = parent === void 0 ? Promise.resolve() : updateDialog.show(parent, {
						type: "info",
						title: locale.messages.updateCheckTitle,
						message: locale.messages.updateChecking,
						buttons: [locale.messages.later],
						cancelId: 0,
						signal: controller.signal
					});
					if (!joinedPolicyAuthentication) checkPolicyManually("deferred").catch((error) => {
						console.error(error);
					});
					state = await updateSchedule.check(true);
				}
				if (revision !== updates.revision) return;
				if (isMandatory()) {
					mandatoryUI?.focus();
					return;
				}
				if (state.phase === "error" && state.failedOperation === "check") {
					await showUpdateFailure(state);
					return;
				}
				if (state.phase === "idle") {
					await ordinaryMessageBox({
						type: "info",
						title: locale.messages.updateCheckTitle,
						message: locale.messages.updateCurrent,
						detail: formatDesktopMessage(locale.messages.updateCurrentDetail, { version: app.getVersion() })
					});
					return;
				}
				if (state.phase === "ready" || state.phase === "error" && state.failedOperation === "install") {
					if (state.version !== void 0) {
						failedOperation = "install";
						await showUpdateFailure(await updates.install(state.version, revision));
					}
					return;
				}
				if (state.phase !== "available" && !(state.phase === "error" && state.failedOperation === "download")) return;
				if (manual) {
					if ((await ordinaryMessageBox({
						title: locale.messages.updateCheckTitle,
						message: formatDesktopMessage(locale.messages.updateAvailable, { version: state.version ?? "" }),
						detail: locale.messages.updateDetail,
						buttons: [locale.messages.updateDownload],
						cancelId: 1
					})).response !== 0) return;
				}
				if (!isMandatory() && state.version !== void 0) {
					controller?.abort();
					failedOperation = "download";
					await showUpdateFailure(await downloadUpdate(state.version, revision));
				}
			} finally {
				controller?.abort();
				if (controller !== void 0) ordinaryDialogs.delete(controller);
				await progress;
			}
		}).catch((error) => showUpdateFailure({
			phase: "error",
			failedOperation,
			message: desktopErrorState(error).message
		})).finally(() => {
			promptOperation = void 0;
			flushQueuedPolicyAuthentication();
		});
		return promptOperation;
	};
	let authenticationOperation;
	const authenticatePolicy = () => {
		if (authenticationOperation !== void 0) {
			policyAuth?.focus();
			updateDialog.focus();
		}
		authenticationOperation ??= runPolicyAuthentication().finally(() => {
			authenticationOperation = void 0;
		});
		return authenticationOperation;
	};
	const flushQueuedPolicyAuthentication = () => {
		if (!policyAuthenticationQueued || promptOperation !== void 0 || authenticationOperation !== void 0 || isMandatory() || quitting) return;
		policyAuthenticationQueued = false;
		authenticatePolicy().catch((error) => {
			console.error(error);
		});
	};
	const queuePolicyAuthentication = () => {
		if (!desktopSettings.updates.allowTestAuthPopupWindow) return;
		if (authenticationOperation !== void 0) {
			policyAuth?.focus();
			updateDialog.focus();
			return;
		}
		policyAuthenticationQueued = true;
		flushQueuedPolicyAuthentication();
	};
	const runPolicyAuthentication = async () => {
		if (!desktopSettings.updates.allowTestAuthPopupWindow || policyAuth === void 0 || mandatoryPolicy === void 0 || quitting) return void 0;
		const parent = mandatoryUI?.confirmationWindow ?? currentDialogWindow();
		if (parent === void 0) return void 0;
		if ((await updateDialog.show(parent, {
			type: "info",
			title: locale.messages.policyLoginTitle,
			message: locale.messages.policyLoginRequired,
			buttons: [locale.messages.policyLogin, locale.messages.later],
			cancelId: 1
		})).response !== 0 || isQuitting()) return void 0;
		const outcome = await policyAuth.login();
		if (isQuitting() || outcome === "cancelled") return void 0;
		if (outcome === "failed") {
			await updateDialog.show(parent, {
				type: "error",
				title: locale.messages.policyLoginTitle,
				message: locale.messages.policyLoginFailed,
				buttons: [locale.messages.updateAcknowledge],
				cancelId: 0
			});
			return;
		}
		await mandatoryPolicy.check("login-return");
		if (isQuitting()) return void 0;
		return mandatoryPolicy.check("login-return", true);
	};
	const checkPolicyManually = async (authentication = "immediate") => {
		if (authenticationOperation !== void 0) return authenticatePolicy();
		const policy = await mandatoryPolicy?.check("manual", true);
		if (policy?.error !== "authentication-required" || !desktopSettings.updates.allowTestAuthPopupWindow) return policy;
		if (authentication === "immediate") return authenticatePolicy();
		queuePolicyAuthentication();
		return policy;
	};
	const automaticCheck = () => {
		if (!quitting) mandatoryPolicy?.check("foreground-or-resume").catch((error) => {
			console.error(error);
		});
		if (!quitting) updateSchedule.check().catch((error) => {
			console.error(error);
		});
	};
	powerMonitor.on("resume", automaticCheck);
	app.on("will-quit", () => {
		updateSchedule.dispose();
		powerMonitor.off("resume", automaticCheck);
		updates.dispose();
	});
	const applicationIconPath = development ? join(app.getAppPath(), "resources", "icon-windows.png") : join(process.resourcesPath, "icon.png");
	app.setAboutPanelOptions({
		applicationName: "DeepSeek Harness",
		applicationVersion: app.getVersion(),
		version: "",
		copyright: "",
		iconPath: applicationIconPath
	});
	const darwin = process.platform === "darwin";
	const macEditMenu = (messages) => ({
		role: "editMenu",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{
				role: "pasteAndMatchStyle",
				accelerator: "Shift+Command+V"
			},
			{
				role: "pasteAndMatchStyle",
				accelerator: "Option+Shift+Command+V",
				visible: false,
				acceleratorWorksWhenHidden: true
			},
			{ role: "delete" },
			{ role: "selectAll" },
			{ type: "separator" },
			{
				label: messages.substitutionsMenu,
				submenu: [
					{ role: "showSubstitutions" },
					{ type: "separator" },
					{ role: "toggleSmartQuotes" },
					{ role: "toggleSmartDashes" },
					{ role: "toggleTextReplacement" }
				]
			},
			{
				label: messages.speechMenu,
				submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }]
			}
		]
	});
	const platformMenus = () => darwin ? [
		shortcuts.fileMenu(currentDesktopLocale().messages),
		macEditMenu(currentDesktopLocale().messages),
		{ role: "windowMenu" }
	] : [{ role: "editMenu" }];
	const hideCommands = darwin ? [
		{
			role: "hide",
			label: currentDesktopLocale().messages.hideApplication
		},
		{
			role: "hideOthers",
			label: currentDesktopLocale().messages.hideOtherApplications
		},
		{
			role: "unhide",
			label: currentDesktopLocale().messages.showAllApplications
		},
		{ type: "separator" }
	] : [];
	const applicationItems = () => [
		process.platform === "win32" ? {
			label: currentDesktopLocale().messages.aboutMenu,
			click: () => {
				showAbout().catch((error) => {
					console.error(error);
				});
			}
		} : {
			label: currentDesktopLocale().messages.aboutMenu,
			role: "about"
		},
		{ type: "separator" },
		{
			label: currentDesktopLocale().messages.checkUpdatesMenu,
			click: () => {
				openUpdatePrompt(true);
			}
		},
		...process.platform === "darwin" || process.platform === "win32" ? [{
			label: currentDesktopLocale().messages.cliCommandMenu,
			click: () => {
				commandManager.show();
			}
		}] : [],
		{ type: "separator" },
		...development ? [{
			label: currentDesktopLocale().messages.reloadPageMenu,
			role: "reload"
		}, {
			label: currentDesktopLocale().messages.restartAppHostMenu,
			click: () => {
				if (quitting) return;
				app.relaunch();
				quitWithoutConfirmation();
			}
		}] : [],
		{
			role: "toggleDevTools",
			label: currentDesktopLocale().messages.toggleDevToolsMenu
		},
		{ type: "separator" },
		...hideCommands,
		{
			role: "quit",
			...darwin ? { label: currentDesktopLocale().messages.quitApplication } : process.platform === "win32" ? { label: currentDesktopLocale().messages.exitApplication } : {}
		}
	];
	const devToolsF12Shortcut = {
		role: "toggleDevTools",
		visible: false,
		accelerator: "F12"
	};
	const windowsDevToolsShortcuts = [{
		role: "toggleDevTools",
		visible: false
	}, devToolsF12Shortcut];
	const refreshApplicationMenu = () => {
		Menu.setApplicationMenu(Menu.buildFromTemplate(process.platform === "win32" ? windowsDevToolsShortcuts : [{
			label: darwin ? app.name : currentDesktopLocale().messages.application,
			submenu: [...applicationItems(), devToolsF12Shortcut]
		}, ...platformMenus()]));
		tray?.relabel();
	};
	refreshApplicationMenu();
	const trayIconPath = development ? join(app.getAppPath(), "resources", "tray-windows.ico") : join(process.resourcesPath, "tray.ico");
	if (process.platform === "win32") try {
		tray = new DesktopTray({
			iconPath: trayIconPath,
			locale: currentDesktopLocale,
			open: () => {
				focusPrimaryWindow();
			},
			quit: () => {
				app.quit();
			}
		});
	} catch (error) {
		console.warn("desktop tray: unavailable", error);
	}
	const backgroundNotice = process.platform === "win32" ? new DesktopBackgroundNotice({
		markerPath: join(app.getPath("userData"), "background-close-confirmed"),
		locale: () => locale,
		show: ordinaryMessageBox,
		focus: () => {
			updateDialog.focus();
		}
	}) : void 0;
	const quitConfirmation = new DesktopQuitConfirmation({
		locale: () => locale,
		inspect: () => backend.host?.inspectQuit(),
		show: (options) => dialog.showMessageBox(options),
		focus: () => {
			if (process.platform === "darwin") app.focus({ steal: true });
		},
		...process.platform === "win32" ? { icon: nativeImage.createFromPath(trayIconPath) } : {}
	});
	if (process.platform === "win32") {
		ipcMain.handle(DESKTOP_IPC.windowsMenu, (event, name, x, y) => {
			assertDesktopSender(event, ["app"]);
			if (mainWindow === void 0 || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("desktop menu: rejected sender");
			if (name !== "application" && name !== "edit" || typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1e5 || y > 1e5) throw new Error("desktop menu: invalid popup request");
			const window = mainWindow;
			const editItem = (label, keyCode, modifiers, accelerator) => ({
				label,
				...accelerator === void 0 ? {} : { accelerator },
				click: () => {
					shortcuts.sendEditingKey(keyCode, modifiers);
				}
			});
			const items = name === "application" ? applicationItems() : [
				editItem(currentDesktopLocale().messages.undo, "Z", ["control"], "Ctrl+Z"),
				editItem(currentDesktopLocale().messages.redo, "Y", ["control"], "Ctrl+Y"),
				{ type: "separator" },
				editItem(currentDesktopLocale().messages.cut, "X", ["control"], "Ctrl+X"),
				editItem(currentDesktopLocale().messages.copy, "C", ["control"], "Ctrl+C"),
				editItem(currentDesktopLocale().messages.paste, "V", ["control"], "Ctrl+V"),
				editItem(currentDesktopLocale().messages.delete, "Delete", []),
				{ type: "separator" },
				editItem(currentDesktopLocale().messages.selectAll, "A", ["control"], "Ctrl+A")
			];
			const zoom = mainWindow.webContents.getZoomFactor();
			return new Promise((resolve) => {
				Menu.buildFromTemplate(items).popup({
					window,
					x: Math.round(x * zoom),
					y: Math.round(y * zoom),
					callback: resolve
				});
			});
		});
		ipcMain.on(DESKTOP_IPC.windowsAppearance, (event, _language, color, symbolColor) => {
			if (mainWindow === void 0 || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
			if (!event.senderFrame.url.startsWith(`dsh-app://app/`)) return;
			const validColor = (value) => typeof value === "string" && /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu.test(value);
			if (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({
				color,
				symbolColor
			});
		});
	}
	const hideMainWindow = (window) => {
		if (process.platform === "darwin" && window.isFullScreen()) {
			window.once("leave-full-screen", () => {
				if (!window.isDestroyed()) window.hide();
			});
			window.setFullScreen(false);
		} else window.hide();
	};
	const createMainWindow = () => {
		const window = createWindow(appPreload, false, true);
		mainWindow = window;
		browserGuests.bind(window, (guest, name) => shortcuts.attachGuest(window, guest, name));
		shortcuts.attach(window);
		window.on("focus", automaticCheck);
		window.on("close", (event) => {
			if (quitting || shellInstallerOwnsQuit || sessionEnding) return;
			event.preventDefault();
			if (updateDialog.isOpen) {
				updateDialog.focus();
				return;
			}
			const hide = () => {
				if (!quitting && !shellInstallerOwnsQuit && !sessionEnding && !window.isDestroyed()) hideMainWindow(window);
			};
			if (backgroundNotice === void 0) hide();
			else backgroundNotice.close(hide);
		});
		if (process.platform === "win32") window.on("session-end", () => {
			sessionEnding = true;
		});
		else {
			window.on("focus", () => {
				sessionEnding = false;
			});
			window.on("show", () => {
				sessionEnding = false;
			});
		}
		window.on("closed", () => {
			if (mainWindow === window) mainWindow = void 0;
		});
		window.webContents.on("console-message", (details) => {
			if (details.level !== "error") return;
			rendererConsole.push(`${details.sourceId}:${String(details.lineNumber)} ${details.message}`);
		});
		window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
			if (isMainFrame && code !== -3 && !quitting && !window.isDestroyed()) reportFatal(/* @__PURE__ */ new Error(`Desktop page failed to load: ${url} (${String(code)}: ${description})`), "renderer");
		});
		window.webContents.on("preload-error", (_event, _path, error) => {
			if (!quitting && !window.isDestroyed()) reportFatal(error, "renderer");
		});
		window.webContents.on("render-process-gone", (_event, details) => {
			navigation = void 0;
			if (!quitting && !window.isDestroyed() && details.reason !== "clean-exit") reportFatal(/* @__PURE__ */ new Error(`Desktop renderer exited: ${details.reason}`), "renderer");
		});
		return window;
	};
	const enterWorkspace = async ({ activate = true } = {}) => {
		if (quitting) return;
		const window = mainWindow ?? createMainWindow();
		await navigateMain(applicationUrl);
		if (isQuitting() || recovery.active || window.isDestroyed()) return;
		if (process.platform === "win32") window.setBackgroundColor(chromeFallbackFill());
		if (activate) window.show();
		else window.showInactive();
		enteredWorkspace = true;
		if (welcomeWindow !== void 0) {
			welcomeWindow.close();
			window.webContents.send(DESKTOP_IPC.enterWorkspace);
		}
		welcomeWindow = void 0;
		if (raiseAfterUpdate) {
			raiseAfterUpdate = false;
			window.moveTop();
			window.focus();
		}
		if (activate && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== "0") window.webContents.openDevTools({ mode: "detach" });
	};
	let openingWelcome;
	const showWelcome = () => {
		if (quitting) return Promise.resolve();
		if (welcomeWindow !== void 0 && !welcomeWindow.isDestroyed()) {
			if (!welcomeWindow.isVisible()) track("auth_page_view", {});
			welcomeWindow.show();
			welcomeWindow.focus();
			return Promise.resolve();
		}
		openingWelcome ??= (async () => {
			welcomeWindow = await openWelcomeWindow(locale, {
				analytics: track,
				analyticsEnabled: () => Promise.resolve(analyticsEnabled),
				takeNotice: () => {
					const notice = pendingWelcomeNotice;
					pendingWelcomeNotice = void 0;
					return Promise.resolve(notice);
				},
				startSignIn: async () => {
					if (welcomeBackend === void 0) throw new Error("desktop welcome: backend unavailable");
					return welcomeBackend.account.start(desktopClientMetadata(locale.id));
				},
				cancelSignIn: async (id) => {
					if (welcomeBackend === void 0) throw new Error("desktop welcome: backend unavailable");
					return welcomeBackend.account.cancel(id);
				},
				copySignInLink: async (id) => {
					const state = await welcomeBackend?.account.state();
					if (state?.attempt?.id !== id || state.attempt.phase !== "waiting-browser" || state.attempt.authorizeUrl === void 0) throw new Error("desktop welcome: login link is unavailable");
					await clipboard.writeText(platformLoginUrl(state.attempt.authorizeUrl));
				},
				saveApiKey: async (apiKey) => {
					if (backend.host === void 0 || welcomeBackend === void 0) return { ok: false };
					const saved = await welcomeBackend.save(apiKey);
					if (!saved.ok) return saved;
					await enterWorkspace();
					return { ok: true };
				},
				skip: enterWorkspace
			});
			const window = welcomeWindow;
			window.once("closed", () => {
				welcomeBackend?.account.state().then((state) => {
					if (state.attempt !== null && !enteredWorkspace) return welcomeBackend?.account.cancel(state.attempt.id);
				}).catch(() => void 0);
			});
			window.once("closed", () => {
				if (welcomeWindow === window) welcomeWindow = void 0;
				if (enteredWorkspace || recovery.active) return;
				if (process.platform === "darwin") mainWindow?.destroy();
				else app.quit();
			});
			if (isQuitting() || recovery.active || enteredWorkspace) window.close();
			else mainWindow?.hide();
		})().finally(() => {
			openingWelcome = void 0;
		});
		return openingWelcome;
	};
	const openInitialWindow = async () => {
		if (quitting || recovery.active) return;
		const state = await readWelcomeState();
		if (isQuitting() || backend.state.phase !== "ready") return;
		nativeTheme.themeSource = state.themePreference;
		locale = resolveDesktopStartupLocale(state.localePreference, systemLanguages);
		writeDesktopLocaleCache(app.getPath("userData"), locale.id);
		windowsLanguage = locale.id;
		refreshApplicationMenu();
		if (!enteredWorkspace && needsWelcome({
			loggedIn: state.loggedIn,
			hasApiKey: state.hasApiKey
		})) {
			raiseAfterUpdate = false;
			await showWelcome();
		} else await enterWorkspace();
	};
	focusPrimaryWindow = () => {
		if (quitting) return;
		if (isMandatory()) {
			mandatoryUI?.focus();
			return;
		}
		const window = welcomeWindow ?? mainWindow;
		if (window === void 0 || window.isDestroyed()) {
			try {
				createMainWindow();
			} catch (error) {
				reportFatal(error, "main");
				return;
			}
			(backend.state.phase === "ready" ? openInitialWindow() : navigateMain(applicationUrl)).catch((error) => {
				reportFatal(error, "main");
			});
			return;
		}
		if (window === mainWindow && !enteredWorkspace) return;
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	};
	if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === "1") app.setAsDefaultProtocolClient("dsh");
	app.on("open-url", (event, url) => {
		event.preventDefault();
		if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow();
	});
	app.on("activate", (_event, hasVisibleWindows) => {
		if (!hasVisibleWindows) focusPrimaryWindow();
	});
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
	if (process.platform !== "win32") powerMonitor.on("shutdown", () => {
		sessionEnding = true;
	});
	const finishQuit = () => {
		quitting = true;
		shuttingDown = true;
		updateJournal?.action("quit-requested");
		quitConfirmation.dispose();
		backgroundNotice?.dispose();
		tray?.dispose();
		stopAccount?.();
		if (welcomeWindow !== void 0 && !welcomeWindow.isDestroyed()) welcomeWindow.hide();
		if (mainWindow !== void 0 && !mainWindow.isDestroyed()) mainWindow.hide();
		updateSchedule.dispose();
		updateDialog.dispose();
		mandatoryUI?.dispose();
		Promise.all([
			stopOperationReports(),
			Promise.resolve(mandatoryPolicy?.dispose()).then(() => policyAuth?.dispose()),
			backend.close().then(async () => {
				await operationJournal?.drain(500);
			}, async (error) => {
				await operationJournal?.drain(500);
				throw error;
			}),
			platformView.dispose(),
			disposeFileDrag()
		].map((cleanup) => cleanup.catch((error) => {
			console.error(error);
		}))).then(() => {
			app.quit();
		});
	};
	app.on("before-quit", (event) => {
		if (shellInstallerOwnsQuit) {
			shuttingDown = true;
			quitConfirmation.dispose();
			backgroundNotice?.dispose();
			updateJournal?.action("quit-requested");
			tray?.dispose();
			updateDialog.dispose();
			mandatoryUI?.dispose();
			platformView.dispose().catch((error) => {
				console.error(error);
			});
			return;
		}
		if (quitting) return;
		event.preventDefault();
		if (skipQuitConfirmation || sessionEnding) {
			finishQuit();
			return;
		}
		quitConfirmation.confirm().then((approved) => {
			if (quitting || shellInstallerOwnsQuit) return;
			if (approved) {
				finishQuit();
				return;
			}
			if (!enteredWorkspace && !recovery.active) showWelcome().catch((error) => {
				reportFatal(error, "main");
			});
		}).catch((error) => {
			console.error(error);
			if (!quitting && !shellInstallerOwnsQuit) finishQuit();
		});
	});
	mainWindow = createMainWindow();
	if (typeof manifest !== "object" || manifest === null) throw new Error("desktop policy: invalid application manifest");
	const developmentPolicy = app.isPackaged ? void 0 : process.env.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG;
	const policyConfig = resolveDesktopPolicyConfig(app.isPackaged ? "dshMandatoryUpdatePolicy" in manifest ? manifest.dshMandatoryUpdatePolicy : void 0 : developmentPolicy === void 0 ? void 0 : JSON.parse(developmentPolicy), !app.isPackaged);
	if (policyConfig !== void 0) {
		if (policyConfig.authentication === "feishu-test") policyAuth = new DesktopPolicyTestAuth(policyConfig.origin, policyConfig.allowedAuthOrigins, locale, () => mandatoryUI?.confirmationWindow ?? currentDialogWindow(), (event) => {
			console.info(`desktop policy authentication: ${event}`);
			updateJournal?.action(`policy-login-${event}`);
		});
		if (!["win32", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error("desktop policy: unsupported platform");
		let wasBlocking = false;
		mandatoryPolicy = new DesktopMandatoryUpdatePolicy(policyConfig, {
			platform: process.platform,
			arch: process.arch,
			get channel() {
				return updates.selectedChannel;
			},
			bundledDshVersion: app.isPackaged ? readDesktopRuntime(resources.dsh).release.version : app.getVersion()
		}, (state) => {
			if (state.error !== "authentication-required") policyAuthenticationQueued = false;
			if (state.blocking) {
				for (const controller of ordinaryDialogs) controller.abort();
				if (!wasBlocking) updateDialog.cancel();
			}
			mandatoryUI?.sync();
			if (state.blocking && !wasBlocking) updateSchedule.check(false, true).catch((error) => {
				console.error(error);
			});
			wasBlocking = state.blocking;
		}, policyAuth?.request, () => desktopClientMetadata(locale.id));
		const policy = mandatoryPolicy;
		mandatoryUI = new DesktopMandatoryUpdateWindow({
			overlays: updateOverlays,
			preload: fileURLToPath(new URL("./preload-mandatory.cjs", import.meta.url)),
			locale,
			allowedPageOrigins: policyConfig.allowedPageOrigins,
			parent: () => mainWindow,
			policy: () => policy.state,
			update: () => updates.state,
			refresh: async () => {
				if (channelState?.error !== void 0) await showConfigurationError();
				if (channelState?.error === void 0) await Promise.all([checkPolicyManually(), updateSchedule.check(true)]);
			},
			download: downloadUpdate,
			install: (version) => updates.install(version)
		});
		mandatoryPolicy.check("launch").then((state) => {
			if (app.isPackaged && state.error === "authentication-required" && !isQuitting()) queuePolicyAuthentication();
		}).catch((error) => {
			console.error(error);
		});
	}
	automaticCheck();
	await reconcileBackend().catch(() => void 0);
	if (isQuitting()) return;
	const window = currentMainWindow();
	if (window !== void 0 && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== "0") window.webContents.openDevTools({ mode: "detach" });
	publishUpdate(updateState);
}
if (claimDesktopSingleInstance(app, () => {
	focusPrimaryWindow();
})) app.whenReady().then(main).catch(async (error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(error);
	const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE;
	if (diagnosticFile !== void 0) await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => void 0);
	reportFatal(error, "main");
}).catch(async (error) => {
	console.error(error);
	shuttingDown = true;
	await stopOperationReports();
	app.exit(1);
});
//#endregion
export {};
