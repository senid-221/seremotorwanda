/* SERE Moto — shared auth library + page controllers (/login, /signup, /admin)
   Vanilla ES5 syntax only: var, function, string concat. No modules, no framework.
   All copy lives in the I18N dictionary below (Kinyarwanda is the default).
   Talks to the real API contract in src/routes/auth.js + src/routes/admin.js. */

(function () {
  'use strict';

  /* =========================================================== dictionary */

  var I18N = {
    rw: {
      /* shared chrome */
      'c.skip': 'Jya ku bwanditsi',
      'c.navLogin': 'Injira',
      'c.navSignup': 'Iyandikishe',
      'c.stageLine': 'Kigali · ijoro n\'amanywa',
      'c.footRights': '© {y} SERE Moto · Kigali, Rwanda',
      'c.footWa': 'Ubufasha kuri WhatsApp',
      'c.footAdmin': 'Injira ya admin',
      'c.close': 'Funga',
      'c.retry': 'Ongera ugerageze',
      'c.loading': 'Biracyategereza…',
      'c.home': 'Ahabanza',
      'ab.tagline': 'Transport & clients',
      'ab.find': 'Passenger', 'ab.join': 'Rider', 'ab.mine': 'Ibyange', 'ab.menu': 'Menu',
      'ab.app': 'Porogaramu', 'ab.guide': 'Uko bikora', 'ab.admin': 'Ubuyobozi',
      'ab.rider': 'Urubuga rw\'umumotari',
      'ab.install': 'Shyira app kuri Phone', 'ab.installed': 'App imaze gushyirwa kuri Phone',

      /* login */
      'lg.eyebrow': 'Injira ya motari',
      'lg.title': 'Injira kuri konti',
      'lg.lede': 'Andika imeyili yawe n\'ijambo ry\'ibanga.',
      'lg.email': 'Imeyili',
      'lg.password': 'Ijambo ry\'ibanga',
      'lg.enter': 'Injira',
      'lg.or': 'cyangwa',
      'lg.entering': 'Byakiriye — urimo kwinjira…',
      'lg.waitTitle': 'Tegereza emeza ya admin',
      'lg.waitBody': '{name}, application yawe iracyategereje ko admin wa SERE Moto ayemeza. Uzatangira wakira demand ihita yemezwa.',
      'lg.waitNote': 'Injira kandi ukoresheje iyi imeyili igihe cyemejwe.',
      'lg.rejTitle': 'Application yawe ntiyemejwe',
      'lg.rejBody': 'Admin wa SERE Moto yanze iyi application. Impamvu:',
      'lg.rejHelp': 'Ushobora kwandikisha ukoresheje izindi nyandiko cyangwa ukavugana na SERE Moto.',
      'lg.noAccount': 'Ntabwo ufite konti?',
      'lg.signupLink': 'Iyandikishe hano',
      'lg.alreadyIn': 'Uramaze kwinjira. Fungura ikibaho cy\'umumotari cyangwa inzira zawe.',

      /* signup */
      'su.eyebrow': 'Iyandikishe kwa motari',
      'su.title': 'Fungura konti',
      'su.lede': 'Tangira ku imeyili, hanyuma uzuze impapuro.',
      'su.lede2': 'Uzuze impapuro kugira ngo admin ya SERE Moto yemeze konti yawe.',
      'su.email': 'Imeyili',
      'su.password': 'Ijambo ry\'ibanga',
      'su.passHint': 'Nibura inyuguti {n}.',
      'su.continue': 'Komeza',
      'su.names': 'Amazina',
      'su.id': 'Indangamuntu',
      'su.tin': 'TIN',
      'su.plate': 'Plaque',
      'su.phone': 'Telefone',
      'su.type': 'Ubwoko bw\'ikinyabiziga',
      'su.moto': 'Moto',
      'su.car': 'Imodoka/Taksi',
      'su.licence': 'Uruhushya rw\'ubucuruzi (PDF)',
      'su.licencePick': 'Hitamo dosiye',
      'su.licenceNone': 'Nta dosiye',
      'su.licenceUploading': 'Iyohereza…',
      'su.licenceDone': 'Dosiye yoherejwe',
      'su.licenceSize': 'Dosiye ntirenge {n} MB.',
      'su.licenceType': 'Koresha PDF cyangwa ifoto.',
      'su.googleNote': 'Konti ya Google izahuza na iyi application.',
      'su.submit': 'Ohereza application',
      'su.doneTitle': 'Byoherejwe',
      'su.doneBody': 'Tegereza ko SERE Moto admin yemeza application yawe.',
      'su.doneSum': '<b>{names}</b> · {plate} · {phone}',
      'su.doneNote': 'Injira ukoresheje {email} kugira ngo ubone status yawe. Tuzakoherereza demand igihe cyemejwe.',
      'su.toLogin': 'Injira kuri konti',
      'su.hasAccount': 'Ufite konti?',
      'su.errNames': 'Andika amazina yawe yose (nibura inyuguti 3).',
      'su.errId': 'Indangamuntu igira imibare 16.',
      'su.errTin': 'TIN igira imibare 9.',
      'su.errPlate': 'Plaque nka RAB 123 A.',
      'su.errPhone': 'Telefone igira imibare 10 (nka 0788123456).',
      'su.errEmail': 'Andika imeyili ushobora gusoma.',
      'su.errPass': 'Ijambo ry\'ibanga rigira nibura inyuguti 8.',
      'su.kycHint': 'TIN isuzumwa kwa RRA, indangamuntu isiuzwe kwa NIDA.',
      'su.tinChecking': 'TIN iragenzurwa kwa RRA…',
      'su.tinOk': 'RRA yemeje iyi TIN.',
      'su.tinOkName': 'RRA yemeje: {name}',
      'su.idChecking': 'Indangamuntu iragenzurwa kwa NIDA…',
      'su.idOk': 'NIDA yemeje iyi ndangamuntu.',
      'su.idOkName': 'NIDA yemeje: amazina ahuye.',
      'su.checkAgain': 'Ongera ugenzure',

      /* admin */
      'ad.eyebrow': 'SERE Moto admin',
      'ad.title': 'Ibyifuzo bya motari',
      'ad.lede': 'Emeza cyangwa wanse application ukurikije inyandiko za KYC.',
      'ad.refresh': 'Vugurura',
      'ad.logout': 'Sohoka',
      'ad.tabPending': 'Zitegereje',
      'ad.tabApproved': 'Zemewe',
      'ad.tabRejected': 'Zanjiwe',
      'ad.tabAll': 'Zose',
      'ad.sPending': 'Zitegereje',
      'ad.sApproved': 'Zemewe',
      'ad.sRejected': 'Zanjiwe',
      'ad.sTotal': 'Zose',
      'ad.sOnline': 'Bari online',
      'ad.sRequests': 'Demand zose',
      'ad.sDone': 'Zarangiye',
      'ad.sPaid': 'Payment zishyuwe',
      'ad.sPendingPay': 'Payment zitegereje',
      'ad.sTodayReq': 'Demand uyu munsi',
      'ad.sTodayPaid': 'Zishyuwe uyu munsi',
      'ad.empty': 'Nta byifuzo muri iyi status.',
      'ad.listErr': 'Urutonde ntabwo rwabashije kuboneka.',
      'ad.approve': 'Emera',
      'ad.reject': 'Inga',
      'ad.reasonLbl': 'Impamvu (nibura inyuguti 3)',
      'ad.reasonPh': 'Urugero: Plaque ntiyemejwe',
      'ad.reasonQuick': 'Impamvu zikunze gukoreshwa',
      'ad.sendReject': 'Ohereza impamvu',
      'ad.cancel': 'Hakana',
      'ad.r1': 'Plaque ntiyemejwe',
      'ad.r2': 'Indangamuntu cyangwa TIN ntibihura n\'umotari',
      'ad.r3': 'Amakuru adahagije kugira ngo yemezwe',
      'ad.kId': 'Indangamuntu',
      'ad.kTin': 'TIN',
      'ad.kPlate': 'Plaque',
      'ad.kPhone': 'Telefone',
      'ad.kZone': 'Zone',
      'ad.kPrice': 'Igiciro / km',
      'ad.kServices': 'Serivise',
      'ad.kCreated': 'Byoherejwe',
      'ad.kReviewed': 'Byasuzumwe',
      'ad.kGoogle': 'Google',
      'ad.kycTin': 'TIN kwa RRA',
      'ad.kycId': 'Indangamuntu kwa NIDA',
      'ad.kycPhone': 'Telefone',
      'ad.kycPass': 'Yemejwe',
      'ad.kycFail': 'Ntiyabonetse',
      'ad.kycNone': 'Itarasuzumwa',
      'ad.kycWait': 'Ntibyasubijwe',
      'ad.kycAgain': 'Ongera ugenzure',
      'ad.yes': 'Yemejwe na Google',
      'ad.no': 'Oya',
      'ad.call': 'Hamagara',
      'ad.gate401Title': 'Injira mbere',
      'ad.gate401Cta': 'Injira nonaha',
      'ad.gate403Title': 'Iyi konti si admin',
      'ad.gate403Body': 'Iyi telefone ntabwo ifite uburenganzira bwa admin. Injira ukoresheje konti ya admin.',
      'ad.incompleteTitle': 'Inyandiko z\'akazi ntizuzuye',
      'ad.incompleteBody': 'Kugira ngo wemeze uyu motari, uzuza zone, serivise n\'igiciro. Ushobora kumuhamagara kuri telefone.',
      'ad.incompleteAsk': 'Uzuza kugira ngo wemeze',
      'ad.missing': 'Bikenewe',
      'ad.svcRide': 'Gutwarwa',
      'ad.svcDelivery': 'Kohereza Imizigo',
      'ad.svcBoth': 'Gutwarwa + Kohereza Imizigo',
      'ad.saveApprove': 'Emera application',
      'ad.reviewed': 'Iyi application yarasuzumwe.',
      'ad.docsNone': 'Uyu motari ntiyatanze ibyangombwa.',
      'ad.statusNow': 'Status: {s}',
      'ad.you': 'Uwemeza',
      'ad.statsErr': 'Imibare ntabwo yabonetse.',

      /* dashboards — shared labels */
      'st.new': 'Nshya',
      'st.seen': 'Bibonywe',
      'st.accepted': 'Byemewe',
      'st.completed': 'Byarangiye',
      'st.cancelled': 'Byahakaniwe',
      'st.declined': 'Byanzwe',
      'pay.paid': 'Byishyuwe',
      'pay.pending': 'Birategereje',
      'pay.failed': 'Byananiwe',
      'pay.refunded': 'Byasubijwe',
      'pay.none': 'Ntibishyuwe',
      'c.refresh': 'Vugurura',
      'c.save': 'Bika',
      'c.saved': 'Byabitswe.',
      'c.search': 'Shakisha',
      'c.all': 'Byose',
      'c.call': 'Hamagara',
      'c.seats': 'Abagenzi',
      'c.commission': 'Komisiyo',
      'c.gross': 'Byose',
      'c.payout': 'Ibyawe',
      'c.collected': 'Byakiriwe',
      'tp.origin': 'Aho atangirira',
      'tp.dest': 'Aho ajya',
      'tp.distance': 'Intera',
      'tp.fare': 'Igiciro',
      'tp.status': 'Imimerere',
      'tp.created': 'Yoherejwe',
      'tp.kind': 'Ubwoko',
      'tp.note': 'Ubutumwa',
      'tp.scheduled': 'Byateganijwe',
      'tp.passengers': 'Abagenzi',
      'tp.payment': 'Kwishyura',
      'tp.rider': 'Umutwari',
      'tp.client': 'Uwifuje',
      'tp.ride': 'Gutwarwa',
      'tp.delivery': 'Kohereza Imizigo',
      'tp.km': '{n} km',

      /* dashboards — rider */
      'rd.eyebrow': 'Urubuga rw\'umumotari',
      'rd.title': 'Ikibaho cy\'umumotari',
      'rd.lede': 'Reba demand, shyira online, ukurikirane amafaranga n\'amanota.',
      'rd.gateTitle': 'Injira nk\'umumotari',
      'rd.gateBody': 'Iyi konti ntabwo ari iya motari. Injira kuri /login cyangwa wiyandikishe nk\'umumotari.',
      'rd.stateAvailable': 'Uri online — wakira demand',
      'rd.stateBusy': 'Ufite umugenzi — rangiza urugendo',
      'rd.stateOffline': 'Uri offline — nta demand ukiri',
      'rd.goOnline': 'Shyira online',
      'rd.goOffline': 'Shyira offline',
      'rd.ready': 'Nditeguye',
      'rd.needProfile': 'Uzuza {list} kugira ngo ujye online.',
      'rd.locSend': 'Ohereza aho uri',
      'rd.locSending': 'Turasoma location yawe…',
      'rd.locLive': 'Location yoherejwe hejuru y\'amasegonda {n}',
      'rd.locStale': 'Location ni ya kera — ohereza iyindi',
      'rd.locAround': 'Uhagaze hafi ya {where}',
      'rd.locNone': 'Nta location dufite kuri iyi konti.',
      'rd.locDenied': 'Telefone yanze kohereza location. Ifungure hanyuma ugerageze.',
      'rd.autoLabel': 'Ohereza location buri minota 2',
      'rd.tabLive': 'Ziriho',
      'rd.tabHistory': 'Ibyakozwe',
      'rd.tabMoney': 'Amafaranga',
      'rd.tabStars': 'Amanota',
      'rd.tabProfile': 'Umwirondoro',
      'rd.docs': 'Ibyangombwa',
      'rd.docsHint': 'Ohereza ifoto y\'ikarita y\'indangamuntu, uruhushya rwo gutwara n\'ifoto y\'ibyapa.',
      'rd.docNationalId': 'Ikarita y\'indangamuntu',
      'rd.docLicence': 'Uruhushya rwo gutwara',
      'rd.docTrading': 'Uruhushya rw\'ubucuruzi',
      'rd.docPlate': 'Ifoto y\'ibyapa',
      'rd.docUpload': 'Ohereza ifoto',
      'rd.docReplace': 'Hindura ifoto',
      'rd.docUploading': 'Turakohereza…',
      'rd.docUploaded': 'Yageze',
      'rd.docPending': 'Ntiyageze',
      'rd.docView': 'Reba',
      'rd.docDone': 'Ifoto yageze mu bubiko.',
      'rd.docType': 'Hitamo ifoto ya JPEG, PNG cyangwa WebP.',
      'rd.docSize': 'Ifoto ntiyagombye kurenza {n} MB.',
      'rd.docUnavailable': 'Ububiko bw\'ibyangombwa ntibwashyizweho kuri iyi seriveri.',
      'rd.newOnes': '{n} nshya',
      'rd.none': 'Nta demand ihari ubu. Jye online kugira ngo wakire.',
      'rd.noHistory': 'Nta nzira z\'amateka urabona.',
      'rd.accept': 'Emera',
      'rd.decline': 'Inga',
      'rd.markSeen': 'Nabibonye',
      'rd.complete': 'Rangiza urugendo',
      'rd.cancelTrip': 'Hakana urugendo',
      'rd.accepted': 'Wakiriye demand — ujye aho uwo twarana.',
      'rd.declined': 'Watanzeho iyi demand.',
      'rd.completed': 'Urugendo rwarangiye. Kanda Nditeguye kugira ngo wakire izindi.',
      'rd.cancelled': 'Urugendo rwahakaniwe.',
      'rd.periodToday': 'Uyu munsi',
      'rd.periodWeek': 'Icyumweru',
      'rd.periodMonth': 'Ukwezi',
      'rd.trips': 'Inzira',
      'rd.done': 'Inzira zarangiye',
      'rd.moneyEmpty': 'Nta nzira zarangiye. Amafaranga azagaragara hano.',
      'rd.unbilled': 'Bitarishyurwa',
      'rd.unbilledBody': 'Inzira {n} zingana na {rwf} ntizishyuruwe.',
      'rd.starsNone': 'Nta manota urahabwa.',
      'rd.starsAvg': 'Impuzandengo {n} ku 5',
      'rd.withComment': 'Bifite ubutumwa: {n}',
      'rd.saveProfile': 'Bika umwirondoro',
      'rd.profileSaved': 'Umwirondoro wabitswe.',
      'rd.kDiv': 'Aho ukorera',
      'rd.divHint': 'Hitamo intara, akarere, umurenge n\'akagari bikorerwamo.',
      'rd.needDivision': 'Banza uhitemo aho ukorera.',
      'rd.priceHint': 'Moto zifata igiciro cya RURA; imodoka ikoresha igiciro cyawe.',
      'rd.slots': 'Igihe ukorera',
      'rd.slotMorning': 'Mu gitondo',
      'rd.slotAfternoon': 'Saa sita',
      'rd.slotEvening': 'Mu mugoroba',
      'rd.slotWeekend': 'Weekend',
      'rd.errPrice': 'Igiciro cy\'ikilometero kigomba kuba hagati ya 100 na 2000 RWF.',

      /* dashboards — passenger */
      'ps.eyebrow': 'Konti yawe',
      'ps.title': 'Ibyawe',
      'ps.lede': 'Andika numero wahakiriyeho. Nta password.',
      'ps.phone': 'Telefone',
      'ps.verifiedShort': 'Telefone yemejwe',
      'ps.hello': 'Muraho, {name}',
      'ps.notPax': 'Iyi konti ni iya motari. Fungura ikibaho cy\'umumotari.',
      'ps.riderArea': 'Urubuga rw\'umumotari',
      'ps.tabTrips': 'Inzira',
      'ps.tabPlaces': 'Ahantu',
      'ps.tabProfile': 'Umwirondoro',
      'ps.scopeActive': 'Ziriho',
      'ps.scopeHistory': 'Zahise',
      'ps.scopeAll': 'Zose',
      'ps.noTrips': 'Nta nzira uragira. Shaka motari.',
      'ps.cancelTrip': 'Hakana urugendo',
      'ps.cancelled': 'Urugendo rwahakaniwe.',
      'ps.pay': 'Kwishyura',
      'ps.payMomo': 'MTN MoMo',
      'ps.payCard': 'Karita',
      'ps.payEmail': 'Imeyili yo kwishyuriraho',
      'ps.payOpen': 'Fungura urupapa rw\'ishyura',
      'ps.payWait': 'Tegereza kwemezwa kwa banki…',
      'ps.payDone': 'Byishyuwe.',
      'ps.payOff': 'Kwishyura hano ntibikora ubu — shyura umumotari.',
      'ps.payChoose': 'Hitamo uko wishyura',
      'ps.confirm': 'Yemeza',
      'ps.nameHint': 'Ni uwa mbere hano — andika amazina yawe (si itegeko).',
      'ps.createdOn': 'Konti yafunguwe',
      'ps.placeConfirm': 'Kuraho {label}?',
      'ps.placeGone': 'Ahantu byakurwaho.',
      'ps.rate': 'Nota',
      'ps.rateTitle': 'Nota urwo rugendo',
      'ps.rateComment': 'Ibitekerezo (si itegeko)',
      'ps.rateSend': 'Ohereza amanota',
      'ps.rateDone': 'Murakoze — amanota yawe yoherejwe.',
      'ps.ratePick': 'Hitamo inyenyeri 1 kugeza 5',
      'ps.rated': 'Watanye {n}★',
      'ps.placeAdd': 'Ongeraho',
      'ps.placeLabel': 'Izina ry\'ahantu',
      'ps.placeAddr': 'Aho ari',
      'ps.placeNone': 'Nta hantu woroheje.',
      'ps.placeBook': 'Hakore urugendo',
      'ps.placeDel': 'Kuraho',
      'ps.name': 'Amazina yawe',
      'ps.email': 'Imeyili',
      'ps.spent': 'Wishyuye',
      'ps.tripsCount': 'Inzira zose',
      'ps.activeCount': 'Ziriho',
      'ps.ratingsGiven': 'Watanze amanota',
      'ps.receipt': 'Urugendo #{id}',
      'ps.ref': 'Reference',

      /* dashboards — admin console */
      'ad.tabOverview': 'Incamake',
      'ad.tabApps': 'Ibyifuzo',
      'ad.tabRiders': 'Abamotari',
      'ad.tabTrips': 'Inzira',
      'ad.tabPayments': 'Amafaranga',
      'ad.tabPassengers': 'Abakiriya',
      'ad.searchPh': 'Amazina, plaque, telefone, zone…',
      'ad.filterOnline': 'Bari online gusa',
      'ad.divCount': 'Abashoferi bo muri {where}: {n}',
      'ad.seenNear': 'Yabonetse hafi ya {where}',
      'ad.riderTrips': '{n} inzira · {gross}',
      'ad.riderOpen': 'Ziriho: {n}',
      'ad.suspend': 'Hagarika',
      'ad.suspendWhy': 'Impamvu (si itegeko)',
      'ad.reinstate': 'Garura',
      'ad.forceOffline': 'Bavuho offline',
      'ad.cancelTrip': 'Hakana inzira',
      'ad.cancelledTrips': 'Inzira {n} zahakaniwe',
      'ad.fee': 'Komisiyo',
      'ad.payoutAll': 'Iby\'abamotari',
      'ad.openMoney': 'Birategereje',
      'ad.sevenDays': 'Iminsi 7 ishirie',
      'ad.zoneSplit': 'Uduce',
      'ad.kindSplit': 'Ubwoko',
      'ad.topRiders': 'Abambere',
      'ad.webhooksSeen': 'Webhooks zakiriwe',
      'ad.webhooksFailed': 'Zananiwe',
      'ad.paxAccounts': 'Konti z\'abakiriya',
      'ad.paxPlaces': 'Ahantu babitse',
      'ad.paxLast': 'Injira ya nyuma',
      'ad.payProvider': 'Serivisi',
      'ad.noRiders': 'Nta bamotari bahaboneka.',
      'ad.noTrips': 'Nta nzira zihaboneka.',
      'ad.noPayments': 'Nta mafaranga arahaboneka.',
      'ad.noPassengers': 'Nta bakiriya arahaboneka.',
      'ad.noData': 'Nta makuru arahari.',
      'ad.sCommission': 'Komisiyo yavuye',
      'ad.sPayout': 'Iby\'abamotari',
      'ad.sPax': 'Abakiriya',
      'ad.sStars': 'Impuzandengo y\'amanota',
      'ad.sGrossToday': 'Uyu munsi',
      'ad.badOnline': 'Ari online',
      'ad.badOffline': 'Ari offline',
      'ad.badBusy': 'Arwaye',
      'ad.sBusy': 'Bafite umugenzi',
      'ad.confirmed': 'Byemejwe',
      'ad.paxGate': 'Iyi konti y\'umukiriya. Fungura urubuga rw\'abakiriya.',
      'ad.tripsOf': 'Inzira za {name}'
    },

    en: {
      /* shared chrome */
      'c.skip': 'Skip to content',
      'c.navLogin': 'Log in',
      'c.navSignup': 'Sign up',
      'c.stageLine': 'Kigali · night and day',
      'c.footRights': '© {y} SERE Moto · Kigali, Rwanda',
      'c.footWa': 'WhatsApp support',
      'c.footAdmin': 'Admin sign-in',
      'c.close': 'Close',
      'c.retry': 'Try again',
      'c.loading': 'Loading…',
      'c.home': 'Home',
      'ab.tagline': 'Transport & clients',
      'ab.find': 'Passenger', 'ab.join': 'Rider', 'ab.mine': 'My account', 'ab.menu': 'Menu',
      'ab.app': 'App', 'ab.guide': 'How it works', 'ab.admin': 'Admin console',
      'ab.rider': 'Driver dashboard',
      'ab.install': 'Install app on Phone', 'ab.installed': 'App is on this Phone',

      /* login */
      'lg.eyebrow': 'Driver access',
      'lg.title': 'Log in to drive',
      'lg.lede': 'Enter your email and your password.',
      'lg.email': 'Email',
      'lg.password': 'Password',
      'lg.enter': 'Log in',
      'lg.or': 'or',
      'lg.entering': 'Welcome — entering…',
      'lg.waitTitle': 'Waiting for admin approval',
      'lg.waitBody': '{name}, your application is still waiting for a SERE Moto admin to approve it. You will get requests after approval.',
      'lg.waitNote': 'Log in again with this email once it is approved.',
      'lg.rejTitle': 'Application not approved',
      'lg.rejBody': 'A SERE Moto admin rejected this application. Reason:',
      'lg.rejHelp': 'You can sign up again with correct documents or talk to SERE Moto.',
      'lg.noAccount': 'No account yet?',
      'lg.signupLink': 'Sign up here',
      'lg.alreadyIn': 'You are already signed in. Open the SERE Moto app.',

      /* signup */
      'su.eyebrow': 'Driver sign-up',
      'su.title': 'Open an account',
      'su.lede': 'Start with an email, then complete the paperwork.',
      'su.lede2': 'Fill in the paperwork so a SERE Moto admin can approve your account.',
      'su.email': 'Email',
      'su.password': 'Password',
      'su.passHint': 'At least {n} characters.',
      'su.continue': 'Continue',
      'su.names': 'Full names',
      'su.id': 'National ID',
      'su.tin': 'TIN',
      'su.plate': 'Plate',
      'su.phone': 'Phone',
      'su.type': 'Vehicle type',
      'su.moto': 'Motorcycle',
      'su.car': 'Car / taxi',
      'su.licence': 'Trading licence (PDF)',
      'su.licencePick': 'Choose a file',
      'su.licenceNone': 'No file',
      'su.licenceUploading': 'Uploading…',
      'su.licenceDone': 'File uploaded',
      'su.licenceSize': 'Keep the file under {n} MB.',
      'su.licenceType': 'Use a PDF or a clear photo.',
      'su.googleNote': 'Your Google account will be linked to this application.',
      'su.submit': 'Submit application',
      'su.doneTitle': 'Submitted',
      'su.doneBody': 'Wait for a SERE Moto admin to approve your application.',
      'su.doneSum': '<b>{names}</b> · {plate} · {phone}',
      'su.doneNote': 'Log in with {email} any time to see your status. Requests start once you are approved.',
      'su.toLogin': 'Log in to your account',
      'su.hasAccount': 'Already registered?',
      'su.errNames': 'Enter your full names (at least 3 characters).',
      'su.errId': 'The national ID has 16 digits.',
      'su.errTin': 'The TIN has 9 digits.',
      'su.errPlate': 'The plate looks like RAB 123 A.',
      'su.errPhone': 'The phone number is 10 digits (such as 0788123456).',
      'su.errEmail': 'Enter an email address you can read.',
      'su.errPass': 'The password must be at least 8 characters.',
      'su.kycHint': 'RRA checks the TIN and NIDA checks the national ID.',
      'su.tinChecking': 'Checking this TIN with RRA…',
      'su.tinOk': 'RRA confirms this TIN.',
      'su.tinOkName': 'RRA confirms: {name}',
      'su.idChecking': 'Checking this ID with NIDA…',
      'su.idOk': 'NIDA confirms this national ID.',
      'su.idOkName': 'NIDA confirms: the names match.',
      'su.checkAgain': 'Check again',

      /* admin */
      'ad.eyebrow': 'SERE Moto admin',
      'ad.title': 'Driver applications',
      'ad.lede': 'Approve or reject applications from their KYC details.',
      'ad.refresh': 'Refresh',
      'ad.logout': 'Log out',
      'ad.tabPending': 'Pending',
      'ad.tabApproved': 'Approved',
      'ad.tabRejected': 'Rejected',
      'ad.tabAll': 'All',
      'ad.sPending': 'Pending',
      'ad.sApproved': 'Approved',
      'ad.sRejected': 'Rejected',
      'ad.sTotal': 'Total',
      'ad.sOnline': 'Online now',
      'ad.sRequests': 'Requests all time',
      'ad.sDone': 'Completed',
      'ad.sPaid': 'Payments paid',
      'ad.sPendingPay': 'Payments pending',
      'ad.sTodayReq': 'Requests today',
      'ad.sTodayPaid': 'Paid today',
      'ad.empty': 'No applications in this status.',
      'ad.listErr': 'The list could not be loaded.',
      'ad.approve': 'Approve',
      'ad.reject': 'Reject',
      'ad.reasonLbl': 'Reason (at least 3 characters)',
      'ad.reasonPh': 'Example: Plate cannot be verified',
      'ad.reasonQuick': 'Common reasons',
      'ad.sendReject': 'Reject with reason',
      'ad.cancel': 'Cancel',
      'ad.r1': 'Plate could not be verified',
      'ad.r2': 'ID card or TIN does not match the rider',
      'ad.r3': 'Not enough detail to approve',
      'ad.kId': 'National ID',
      'ad.kTin': 'TIN',
      'ad.kPlate': 'Plate',
      'ad.kPhone': 'Phone',
      'ad.kZone': 'Zone',
      'ad.kPrice': 'Price / km',
      'ad.kServices': 'Services',
      'ad.kCreated': 'Submitted',
      'ad.kReviewed': 'Reviewed',
      'ad.kGoogle': 'Google',
      'ad.kycTin': 'TIN at RRA',
      'ad.kycId': 'National ID at NIDA',
      'ad.kycPhone': 'Phone line',
      'ad.kycPass': 'Confirmed',
      'ad.kycFail': 'Not found',
      'ad.kycNone': 'Not checked',
      'ad.kycWait': 'No answer',
      'ad.kycAgain': 'Re-check',
      'ad.yes': 'Linked to Google',
      'ad.no': 'No',
      'ad.call': 'Call',
      'ad.gate401Title': 'Sign in first',
      'ad.gate401Cta': 'Log in now',
      'ad.gate403Title': 'This account is not an admin',
      'ad.gate403Body': 'The account you are signed in with has no admin rights. Use an admin account.',
      'ad.incompleteTitle': 'Operating details are missing',
      'ad.incompleteBody': 'To approve this rider, add the zone, services and price per km. You can ask them on the phone.',
      'ad.incompleteAsk': 'Fill these in to approve',
      'ad.missing': 'Required',
      'ad.svcRide': 'Get a ride',
      'ad.svcDelivery': 'Send goods (Delivery)',
      'ad.svcBoth': 'Ride + send goods',
      'ad.saveApprove': 'Approve application',
      'ad.reviewed': 'This application is already reviewed.',
      'ad.docsNone': 'This rider has not uploaded any documents yet.',
      'ad.statusNow': 'Status: {s}',
      'ad.you': 'Reviewer',
      'ad.statsErr': 'The figures could not be loaded.',

      /* dashboards — shared labels */
      'st.new': 'New',
      'st.seen': 'Seen',
      'st.accepted': 'Accepted',
      'st.completed': 'Completed',
      'st.cancelled': 'Cancelled',
      'st.declined': 'Declined',
      'pay.paid': 'Paid',
      'pay.pending': 'Awaiting',
      'pay.failed': 'Failed',
      'pay.refunded': 'Refunded',
      'pay.none': 'Not paid',
      'c.refresh': 'Refresh',
      'c.save': 'Save',
      'c.saved': 'Saved.',
      'c.search': 'Search',
      'c.all': 'All',
      'c.call': 'Call',
      'c.seats': 'Seats',
      'c.commission': 'Commission',
      'c.gross': 'Gross',
      'c.payout': 'Your payout',
      'c.collected': 'Collected',
      'tp.origin': 'Pickup',
      'tp.dest': 'Drop-off',
      'tp.distance': 'Distance',
      'tp.fare': 'Fare',
      'tp.status': 'Status',
      'tp.created': 'Booked',
      'tp.kind': 'Kind',
      'tp.note': 'Note',
      'tp.scheduled': 'Scheduled',
      'tp.passengers': 'Passengers',
      'tp.payment': 'Payment',
      'tp.rider': 'Rider',
      'tp.client': 'Client',
      'tp.ride': 'Ride',
      'tp.delivery': 'Delivery',
      'tp.km': '{n} km',

      /* dashboards — rider */
      'rd.eyebrow': 'Driver area',
      'rd.title': 'Driver dashboard',
      'rd.lede': 'See requests, go online, follow your earnings and ratings.',
      'rd.gateTitle': 'Sign in as a driver',
      'rd.gateBody': 'This session is not a driver account. Log in at /login or register as a rider.',
      'rd.stateAvailable': 'Online — ready for requests',
      'rd.stateBusy': 'With a passenger — finish the trip',
      'rd.stateOffline': 'Offline — you receive no requests',
      'rd.goOnline': 'Go online',
      'rd.goOffline': 'Go offline',
      'rd.ready': 'NDITEGUYE',
      'rd.needProfile': 'Add {list} before going online.',
      'rd.locSend': 'Send my location',
      'rd.locSending': 'Reading your location…',
      'rd.locLive': 'Location posted {n}s ago',
      'rd.locStale': 'Location is old — post a fresh one',
      'rd.locAround': 'You are around {where}',
      'rd.locNone': 'No location on record for this account.',
      'rd.locDenied': 'Your phone refused to share location. Allow it and try again.',
      'rd.autoLabel': 'Post location every 2 minutes',
      'rd.tabLive': 'Live',
      'rd.tabHistory': 'History',
      'rd.tabMoney': 'Earnings',
      'rd.tabStars': 'Ratings',
      'rd.tabProfile': 'Profile',
      'rd.docs': 'Documents',
      'rd.docsHint': 'Upload a photo of your national ID, driving licence and plate.',
      'rd.docNationalId': 'National ID',
      'rd.docLicence': 'Driving licence',
      'rd.docTrading': 'Trading licence',
      'rd.docPlate': 'Plate photo',
      'rd.docUpload': 'Upload photo',
      'rd.docReplace': 'Replace photo',
      'rd.docUploading': 'Uploading…',
      'rd.docUploaded': 'Uploaded',
      'rd.docPending': 'Not uploaded',
      'rd.docView': 'View',
      'rd.docDone': 'The photo reached storage.',
      'rd.docType': 'Choose a JPEG, PNG or WebP image.',
      'rd.docSize': 'Keep the photo under {n} MB.',
      'rd.docUnavailable': 'Document storage is not configured on this server.',
      'rd.newOnes': '{n} new',
      'rd.none': 'No requests right now. Go online to receive them.',
      'rd.noHistory': 'No past trips yet.',
      'rd.accept': 'Accept',
      'rd.decline': 'Decline',
      'rd.markSeen': 'Mark as seen',
      'rd.complete': 'Complete trip',
      'rd.cancelTrip': 'Cancel trip',
      'rd.accepted': 'Accepted — head to the pickup point.',
      'rd.declined': 'You declined this request.',
      'rd.completed': 'Trip completed. Press NDITEGUYE to receive new requests.',
      'rd.cancelled': 'Trip cancelled.',
      'rd.periodToday': 'Today',
      'rd.periodWeek': 'Week',
      'rd.periodMonth': 'Month',
      'rd.trips': 'Trips',
      'rd.done': 'Completed trips',
      'rd.moneyEmpty': 'No completed trips yet. Earnings will appear here.',
      'rd.unbilled': 'Awaiting payment',
      'rd.unbilledBody': '{n} trips worth {rwf} are still unpaid.',
      'rd.starsNone': 'No ratings yet.',
      'rd.starsAvg': 'Average {n} out of 5',
      'rd.withComment': 'With comments: {n}',
      'rd.saveProfile': 'Save profile',
      'rd.profileSaved': 'Profile saved.',
      'rd.kDiv': 'Where you work',
      'rd.divHint': 'Choose the province, district, sector and cell you work in.',
      'rd.needDivision': 'Pick the division you work in.',
      'rd.priceHint': 'Motorcycles follow the RURA table; cars use your own rate.',
      'rd.slots': 'Working times',
      'rd.slotMorning': 'Morning',
      'rd.slotAfternoon': 'Afternoon',
      'rd.slotEvening': 'Evening',
      'rd.slotWeekend': 'Weekend',
      'rd.errPrice': 'The price per km must be between 100 and 2000 RWF.',

      /* dashboards — passenger */
      'ps.eyebrow': 'Your account',
      'ps.title': 'My trips',
      'ps.lede': 'Enter the number you booked with. No password.',
      'ps.phone': 'Phone',
      'ps.verifiedShort': 'Phone verified',
      'ps.hello': 'Hello, {name}',
      'ps.notPax': 'This session is a driver account. Open the driver dashboard.',
      'ps.riderArea': 'Driver dashboard',
      'ps.tabTrips': 'Trips',
      'ps.tabPlaces': 'Places',
      'ps.tabProfile': 'Profile',
      'ps.scopeActive': 'Active',
      'ps.scopeHistory': 'History',
      'ps.scopeAll': 'All',
      'ps.noTrips': 'No trips yet. Find a moto.',
      'ps.cancelTrip': 'Cancel trip',
      'ps.cancelled': 'Trip cancelled.',
      'ps.pay': 'Pay',
      'ps.payMomo': 'MTN MoMo',
      'ps.payCard': 'Card',
      'ps.payEmail': 'Email for the payment',
      'ps.payOpen': 'Open the payment page',
      'ps.payWait': 'Waiting for the payment to confirm…',
      'ps.payDone': 'Paid.',
      'ps.payOff': 'Paying here is not available right now — pay the rider directly.',
      'ps.payChoose': 'Choose how to pay',
      'ps.confirm': 'Confirm',
      'ps.nameHint': 'First time here — add your name (optional).',
      'ps.createdOn': 'Account created',
      'ps.placeConfirm': 'Remove {label}?',
      'ps.placeGone': 'Place removed.',
      'ps.rate': 'Rate',
      'ps.rateTitle': 'Rate that trip',
      'ps.rateComment': 'Comment (optional)',
      'ps.rateSend': 'Send rating',
      'ps.rateDone': 'Thank you — your rating was sent.',
      'ps.ratePick': 'Pick 1 to 5 stars',
      'ps.rated': 'You rated {n}★',
      'ps.placeAdd': 'Add',
      'ps.placeLabel': 'Place name',
      'ps.placeAddr': 'Address',
      'ps.placeNone': 'No saved places yet.',
      'ps.placeBook': 'Book from here',
      'ps.placeDel': 'Remove',
      'ps.name': 'Your name',
      'ps.email': 'Email',
      'ps.spent': 'Spent',
      'ps.tripsCount': 'Total trips',
      'ps.activeCount': 'Active',
      'ps.ratingsGiven': 'Ratings given',
      'ps.receipt': 'Trip #{id}',
      'ps.ref': 'Reference',

      /* dashboards — admin console */
      'ad.tabOverview': 'Overview',
      'ad.tabApps': 'Applications',
      'ad.tabRiders': 'Riders',
      'ad.tabTrips': 'Trips',
      'ad.tabPayments': 'Payments',
      'ad.tabPassengers': 'Passengers',
      'ad.searchPh': 'Name, plate, phone, zone…',
      'ad.filterOnline': 'Online only',
      'ad.divCount': 'Riders in {where}: {n}',
      'ad.seenNear': 'Seen near {where}',
      'ad.riderTrips': '{n} trips · {gross}',
      'ad.riderOpen': 'Open: {n}',
      'ad.suspend': 'Suspend',
      'ad.suspendWhy': 'Reason (optional)',
      'ad.reinstate': 'Reinstate',
      'ad.forceOffline': 'Force offline',
      'ad.cancelTrip': 'Cancel trip',
      'ad.cancelledTrips': '{n} trips cancelled',
      'ad.fee': 'Commission',
      'ad.payoutAll': 'Driver payouts',
      'ad.openMoney': 'Awaiting',
      'ad.sevenDays': 'Last 7 days',
      'ad.zoneSplit': 'Zones',
      'ad.kindSplit': 'Kinds',
      'ad.topRiders': 'Top riders',
      'ad.webhooksSeen': 'Webhooks received',
      'ad.webhooksFailed': 'Failed',
      'ad.paxAccounts': 'Passenger accounts',
      'ad.paxPlaces': 'Saved places',
      'ad.paxLast': 'Last sign-in',
      'ad.payProvider': 'Provider',
      'ad.noRiders': 'No riders match.',
      'ad.noTrips': 'No trips match.',
      'ad.noPayments': 'No payments yet.',
      'ad.noPassengers': 'No passengers yet.',
      'ad.noData': 'Nothing to show yet.',
      'ad.sCommission': 'Commission earned',
      'ad.sPayout': 'Driver payouts',
      'ad.sPax': 'Passengers',
      'ad.sStars': 'Average stars',
      'ad.sGrossToday': 'Today',
      'ad.badOnline': 'Online',
      'ad.badOffline': 'Offline',
      'ad.badBusy': 'With passenger',
      'ad.sBusy': 'With a passenger',
      'ad.confirmed': 'Confirmed',
      'ad.paxGate': 'This is a passenger account. Open the passenger area.',
      'ad.tripsOf': 'Trips by {name}'
    }
  };

  /* known API error codes -> our own sentence (server message wins when unknown) */
  var EC = {
    rw: {
      invalid_phone: "Telefone igira imibare 10 ya Rwande (078… cyangwa 072…).",
      phone_invalid: 'Iyi numero ntari muri gahunda ya telefone ya Rwanda — reba imibare wanditse.',
      verify_rate_limited: 'Wagenzuye iyi numero incuro nyinshi — tegereza gato.',
      tin_check_unavailable: 'Kugenzura TIN kwa RRA ntigukora ubu — wohereza application ariko.',
      tin_not_found: 'Iyi TIN ntiboneka mu misoro ya RRA.',
      id_check_unavailable: 'Kugenzura indangamuntu kwa NIDA ntigukora ubu — wohereza application ariko.',
      id_not_found: 'Iyi ndangamuntu ntiboneka mu nyandiko za NIDA.',
      id_name_mismatch: 'Amazina wanditse ntahuye n\'ayiyi ndangamuntu kwa NIDA.',
      phone_check_unavailable: 'Kugenzura telefone ntigukora ubu.',
      phone_not_live: 'Iyi numero ntikorera ku biganza bya Rwanda.',
      kyc_rate_limited: 'Kugenzura byinshi kuri iyi numero — tegereza gato.',
      kyc_unreachable: 'Isuzuma ry\'inyandiko ntiryakozwe — gerageza nyuma.',
      phone_taken: 'Iyi numero isanzwe ifite konti. Injira aho kwandikisha.',
      id_number_taken: 'Iyi ndangamuntu isanzwe yanditswe.',
      tin_number_taken: 'Iyi TIN isanzwe yanditswe.',
      plate_taken: 'Iyi plaque isanzwe ku wundi motari.',
      google_taken: 'Konti ya Google isanzwe ifite undi motari.',
      already_registered: 'Aya makuru asanzwe yanditswe.',
      invalid_names: 'Amazina ntabwo ayo. Andika amazina yawe yose.',
      invalid_id_number: 'Indangamuntu igira imibare 16.',
      invalid_tin_number: 'TIN igira imibare 9.',
      invalid_plate: 'Plaque nka RAB 123 A.',
      invalid_vehicle_type: 'Hitamo Moto cyangwa Imodoka/Taksi.',
      invalid_google_token: 'Ihuza rya Google ryarangiye. Injira na Google kandi.',
      google_token_invalid: 'Google yohereje amakuru adasobanutse. Subira ugerageze.',
      google_token_expired: 'Igihe cya Google cyarangiye. Injira na Google kandi.',
      google_signature_invalid: 'Imeza rya Google ntiryemewe. Subira ugerageze.',
      google_key_unknown: 'Ubufunguzo bwa Google bwahindutse. Subira ugerageze.',
      google_audience_mismatch: 'Iyi konti ya Google ntijyanye n\'iyi site.',
      google_issuer_mismatch: 'Ibi ntibivanye kuri Google. Injira ukoresheje Google.',
      google_lookup_failed: 'Google ntiyasubije. Gerageza nyuma.',
      google_not_configured: 'Kwinjira na Google ntibikora ubu.',
      authentication_required: 'Injira mbere kuri konti yawe.',
      admin_only: 'Iyi konti ntabwo ari iya admin.',
      account_pending: 'Konti iracyegereza emeza ya admin.',
      incomplete_profile: 'Inyandiko z\'akazi ntizuzuye.',
      already_reviewed: 'Iki cyifuzo cyarasuzumwe.',
      application_not_found: 'Nta cyifuzo kiboneka.',
      invalid_status: 'Status ntabwo ayo.',
      invalid_action: 'Igikorwa ntabwo ayo.',
      invalid_reason: 'Andika impamvu (nibura inyuguti 3).',
      server_error: 'Server ntibashije kurangiza ikifuzo.',
      invalid_json: 'Ikibazo kuutumwa — gerageza kandi.',
      not_found: 'Iyi nzira ntibaho.',
      network: 'Server ntabwo yitabiriye — genzura internet yawe.',
      trip_not_found: 'Nta nzira iboneka.',
      request_not_found: 'Nta demand iboneka.',
      rider_not_found: 'Nta mumotari uboneka.',
      driver_not_found: 'Uwo mumotari ntabwo akiri kuri SERE Moto.',
      driver_offline: 'Uyu mumotari uri offline — hitamo undi.',
      driver_busy: 'Uyu mumotari amaze kugira umugenzi — hitamo undi.',
      driver_unavailable: 'Uyu mumotari ntabwo akora kuri SERE Moto.',
      service_not_offered: 'Uyu mumotari ntaguha iyo serivise.',
      capacity_exceeded: 'Iki kinyabiziga ntikibika abagenzi bangana gutyo.',
      not_cancellable: 'Iyi nzira ntishobora guhakanwa ubu.',
      not_completed: 'Wnota inzira yarangiye gusa.',
      not_payable: 'Iyi nzira ntishobora kwishyurwa ubu.',
      already_rated: 'Iyi nzira wayatanije amanota.',
      place_exists: 'Ahantu rifite iryo zina gasanzwe.',
      place_not_found: 'Nta hantu haboneka.',
      provider_not_configured: 'Serivisi yo kwishyura ntirashyirwaho — shyura umumotari.',
      paystack_not_configured: 'Kwishyura na karita ntibikora ubu — shyura umumotari.',
      momo_not_configured: 'Kwishyura kuri MoMo ntibikora ubu — shyura umumotari.',
      provider_unreachable: 'Serivisi yo kwishyura ntisubije — gerageza nyuma.',
      momo_rejected: 'Kwishyura byanze kuri telefone yawe.',
      momo_auth_failed: 'Serivisi ya MoMo ntiyemera konti ya SERE Moto.',
      paystack_rejected: 'Karita yanze kwishyura — ongera ugerageze.',
      unknown_provider: 'Ubwoko bw\'ishyura ntibuzwi.',
      payment_not_found: 'Nta shyura riboneka.',
      invalid_email: 'Andika imeyili ushobora gusoma, nka name@gmail.com.',
      invalid_password: 'Ijambo ry\'ibanga rigira nibura inyuguti 8.',
      invalid_credentials: 'Iyi imeyili n\'ijambo ry\'ibanga ntibihuye na konti.',
      login_rate_limited: 'Wagerageje kwinjira incuro nyinshi — gerageza nyuma y\'isaha.',
      email_taken: 'Iyi imeyili isanzwe ifite konti. Injira aho kwandikisha.',
      google_account_only: 'Iyi konti yafunguwe na Google. Injira ukoresheje Google.',
      details_already_filed: 'Application yawe yamaze koherezwa. Tegereza emeza ya admin.',
      licence_required: 'Banza wohereze uruhushya rw\'ubucuruzi (PDF).',
      storage_not_configured: 'Ububiko bw\'ibyangombwa ntibwashyizweho kuri iyi seriveri.',
      unsupported_document_type: 'Koresha PDF cyangwa ifoto ya JPEG, PNG, WebP.',
      document_too_large: 'Ifoto ni nini cyane — koresha iyindi ntoya.',
      document_not_uploaded: 'Ifoto ntiyageze mu bubiko — ongera uyikorehereze.',
      document_not_started: 'Banza usabe urubuga rwo kohereza ifoto.',
      invalid_stars: 'Hitamo inyenyeri 1 kugeza 5.',
      invalid_online: 'Hitamo online cyangwa offline.',
      invalid_comment: 'Ubutumwa bw\'amanota burebure cyane.',
      invalid_address: 'Andika aho ahari.',
      invalid_label: 'Andika izina ry\'ahantu.',
      empty_update: 'Ohereza ikintu kimwe nibura cyo kubika.',
      forbidden: 'Ibi ntibikurikira kuri konti yawe.',
      passenger_authentication_required: 'Injira ukoresheje numero ya telefone yawe.',
      phone_not_yours: 'Koresha numero yawe wemeje gusa.',
      already_suspended: 'Uyu mumotari asanzwe hagaritswe.',
      already_approved: 'Uyu mumotari asanzwe yemezwe.',
      cannot_modify_admin: 'Konti ya admin ntihagarikwa.',
      division_not_found: 'Aho hantu ntigaragara mu turere tw\'u Rwanda — hitamo mu dropdown.',
      divisions_unavailable: 'Nta turere rubatswe kuri iyi server — gerageza nyuma.',
      divisions_unmapped: 'Ntidushoboye kumenya agace kari hafi yawe — koresha dropdown.',
      invalid_location_code: 'Hitamo aho ukorera muri dropdown y\'intara/akarere/umurenge.',
      invalid_division: 'Agace kashunguwemo ntikagaragara — hitamo muri dropdown.',
      profile_incomplete: 'Umwirondoro ntuzuye.',
      invalid_status_change: 'Iyi mimerere ntihinduka gutyo.',
      fallback: 'Igikorwa nticyakunze — gerageza kandi.'
    },
    en: {
      invalid_phone: 'That is not a 10-digit Rwandan phone number (078… or 072…).',
      phone_invalid: 'That number is not in the Rwandan numbering plan — check the digits you typed.',
      verify_rate_limited: 'This number was checked too many times — wait a moment.',
      tin_check_unavailable: 'The RRA TIN check is not available right now — you can still submit.',
      tin_not_found: 'No RRA taxpayer holds this TIN.',
      id_check_unavailable: 'The NIDA ID check is not available right now — you can still submit.',
      id_not_found: 'This national ID is not in the NIDA register.',
      id_name_mismatch: 'The names held for this ID do not match the names you entered.',
      phone_check_unavailable: 'The phone line check is not available right now.',
      phone_not_live: 'This number is not active on any Rwandan network.',
      kyc_rate_limited: 'Too many checks for this number — wait a moment.',
      kyc_unreachable: 'The document check could not be completed — try again later.',
      phone_taken: 'This number already has an account. Log in instead.',
      id_number_taken: 'This national ID is already registered.',
      tin_number_taken: 'This TIN is already registered.',
      plate_taken: 'That plate already belongs to another rider.',
      google_taken: 'That Google account is linked to another rider.',
      already_registered: 'Those details are already registered.',
      invalid_names: 'The names are not valid. Enter your full names.',
      invalid_id_number: 'The national ID must be 16 digits.',
      invalid_tin_number: 'The TIN must be 9 digits.',
      invalid_plate: 'The plate looks like RAB 123 A.',
      invalid_vehicle_type: 'Choose Moto or Car / taxi.',
      invalid_google_token: 'That Google link expired. Use Google sign-in again.',
      google_token_invalid: 'Google sent an unreadable account. Try Google sign-in again.',
      google_token_expired: 'That Google sign-in expired. Use Google again.',
      google_signature_invalid: 'That Google signature was not accepted. Try again.',
      google_key_unknown: 'Google changed its signing key. Try again.',
      google_audience_mismatch: 'That Google account was not issued for this site.',
      google_issuer_mismatch: 'That token did not come from Google. Use Google sign-in.',
      google_lookup_failed: 'Google did not respond. Try again in a moment.',
      google_not_configured: 'Google sign-in is not available right now.',
      authentication_required: 'Sign in to your account first.',
      admin_only: 'This account is not an admin.',
      account_pending: 'This account is still waiting for admin approval.',
      incomplete_profile: 'Operating details are missing.',
      already_reviewed: 'This application is already reviewed.',
      application_not_found: 'No such application.',
      invalid_status: 'That status is not valid.',
      invalid_action: 'That action is not valid.',
      invalid_reason: 'Write a reason (at least 3 characters).',
      server_error: 'The server could not complete the request.',
      invalid_json: 'Something is wrong with the request — try again.',
      not_found: 'That route does not exist.',
      network: 'The server did not answer — check your connection.',
      trip_not_found: 'No such trip.',
      request_not_found: 'No such request.',
      rider_not_found: 'No such rider.',
      driver_not_found: 'That driver is no longer registered.',
      driver_offline: 'That driver is offline right now — pick another one.',
      driver_busy: 'That driver is already carrying a passenger — pick another one.',
      driver_unavailable: 'That driver is not active on SERE Moto.',
      service_not_offered: 'That driver does not offer this service.',
      capacity_exceeded: 'That vehicle carries fewer passengers.',
      not_cancellable: 'This trip can no longer be cancelled.',
      not_completed: 'Only a finished trip can be rated.',
      not_payable: 'This trip cannot be paid right now.',
      already_rated: 'You already rated this trip.',
      place_exists: 'You already saved a place with that name.',
      place_not_found: 'No such saved place.',
      provider_not_configured: 'Payment is not set up yet — pay the rider directly.',
      paystack_not_configured: 'Card payment is not available right now — pay the rider directly.',
      momo_not_configured: 'MoMo payment is not available right now — pay the rider directly.',
      provider_unreachable: 'The payment service did not answer — try again later.',
      momo_rejected: 'The payment was refused on your phone.',
      momo_auth_failed: 'MoMo did not accept the SERE Moto credentials.',
      paystack_rejected: 'The card was declined — try again.',
      unknown_provider: 'That payment method is not known.',
      payment_not_found: 'No such payment.',
      invalid_email: 'Enter an email address you can read, like name@gmail.com.',
      invalid_password: 'The password must be at least 8 characters.',
      invalid_credentials: 'That email and password do not match an account.',
      login_rate_limited: 'Too many sign-in attempts — try again in an hour.',
      email_taken: 'That email address already has an account. Log in instead.',
      google_account_only: 'This account was opened with Google. Continue with Google.',
      details_already_filed: 'Your application is already submitted. Wait for admin approval.',
      licence_required: 'Attach your trading licence (PDF) first.',
      storage_not_configured: 'Document storage is not configured on this server.',
      unsupported_document_type: 'Use a PDF or a JPEG, PNG or WebP photo.',
      document_too_large: 'That image is too large — choose a smaller one.',
      document_not_uploaded: 'The file did not reach storage — upload it again.',
      document_not_started: 'Ask for an upload link before sending the photo.',
      invalid_stars: 'Pick from 1 to 5 stars.',
      invalid_online: 'Choose online or offline.',
      invalid_comment: 'That rating comment is too long.',
      invalid_address: 'Write where the place is.',
      invalid_label: 'Write a name for the place.',
      empty_update: 'Send at least one thing to save.',
      forbidden: 'That does not belong to your account.',
      passenger_authentication_required: 'Sign in with your phone number first.',
      phone_not_yours: 'Use your own verified number.',
      already_suspended: 'This rider is already suspended.',
      already_approved: 'This rider is already approved.',
      cannot_modify_admin: 'An admin account cannot be suspended.',
      division_not_found: 'That place is not one of Rwanda\'s divisions — pick it from the dropdown.',
      divisions_unavailable: 'This server has no division list loaded — try again later.',
      divisions_unmapped: 'We could not match your position to a Rwandan area — use the dropdown.',
      invalid_location_code: 'Pick where you work from the province / district / sector dropdown.',
      invalid_division: 'That filtered division is not one of Rwanda\'s — pick it from the dropdown.',
      profile_incomplete: 'Your profile is not complete.',
      invalid_status_change: 'That status cannot change like this.',
      fallback: 'That did not work — please try again.'
    }
  };

  var VEHICLE = { moto: { rw: 'Moto', en: 'Motorcycle' }, car: { rw: 'Imodoka/Taksi', en: 'Car / taxi' } };
  var SERVICES = { ride: 'ad.svcRide', delivery: 'ad.svcDelivery', both: 'ad.svcBoth' };
  var STATUS_LABEL = { pending: 'ad.tabPending', approved: 'ad.tabApproved', rejected: 'ad.tabRejected' };
  var TRIP_STATUS = {
    new: 'st.new', seen: 'st.seen', accepted: 'st.accepted',
    completed: 'st.completed', cancelled: 'st.cancelled', declined: 'st.declined'
  };
  var PAY_STATUS = {
    paid: 'pay.paid', pending: 'pay.pending', failed: 'pay.failed', refunded: 'pay.refunded'
  };
  var KIND_LABEL = { ride: 'tp.ride', delivery: 'tp.delivery' };

  /* ============================================================== utilities */

  var lang = 'rw';
  try { lang = localStorage.getItem('sere_lang') || 'rw'; } catch (e) { lang = 'rw'; }
  if (lang !== 'en') { lang = 'rw'; }

  var langHooks = [];

  function dict() { return I18N[lang] || I18N.en; }

  function t(key, vars) {
    var s = (I18N[lang] && I18N[lang][key]);
    if (s == null) { s = I18N.en[key]; }
    if (s == null) { s = key; }
    if (vars) { s = subst(s, vars); }
    return s;
  }

  function subst(s, vars) {
    var out = String(s);
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) {
        out = out.split('{' + k + '}').join(String(vars[k]));
      }
    }
    return out;
  }

  function errText(err) {
    var code = err && err.code;
    if (code && EC[lang] && EC[lang][code]) { return EC[lang][code]; }
    if (code && EC.en[code]) { return EC.en[code]; }
    if (err && err.message) { return err.message; }
    return t('c.loading');
  }

  function ecOf(code, message) {
    var err = new Error(message || code || 'error');
    err.code = code || '';
    return errText(err);
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
      .split('"').join('&quot;').split("'").join('&#39;');
  }

  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }
  function text(node, value) { if (node) { node.textContent = value; } return node; }
  function visible(node, on) { if (node) { node.hidden = !on; } return node; }

  function loading(node, on) {
    if (!node) { return; }
    if (on) { node.classList.add('loading'); node.disabled = true; }
    else { node.classList.remove('loading'); node.disabled = false; }
  }

  function onLang(fn) { langHooks.push(fn); }

  /* ============================================================ i18n engine */

  function applyLang() {
    document.documentElement.setAttribute('lang', lang);
    try { localStorage.setItem('sere_lang', lang); } catch (e) { /* private mode */ }

    qa('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    qa('[data-i18h]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18h')); });
    qa('[data-i18n-ph]').forEach(function (el) { el.placeholder = t(el.getAttribute('data-i18n-ph')); });
    qa('[data-i18n-title]').forEach(function (el) {
      var s = t(el.getAttribute('data-i18n-title'));
      el.setAttribute('title', s);
      el.setAttribute('aria-label', s);
    });
    qa('[data-i18n-tip]').forEach(function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-tip'))); });
    qa('.lang button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang));
    });

    for (var i = 0; i < langHooks.length; i++) {
      try { langHooks[i](); } catch (e) { /* a hook must not break the toggle */ }
    }
  }

  function setLang(next) {
    if (next !== 'rw' && next !== 'en') { return; }
    lang = next;
    applyLang();
  }

  function wireLang() {
    qa('.lang button').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.getAttribute('data-lang')); });
    });
  }

  /* ================================================================= tokens */

  var TOKEN_KEY = 'sere_token';

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(value) {
    try { if (value) { localStorage.setItem(TOKEN_KEY, value); } } catch (e) { /* ignore */ }
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  /* ==================================================================== api */

  /* Division names are built by the server, so every call tells it which language the page is in.
     A path that already carries lang= (the division dropdowns) is left exactly as it is. */
  function withLang(path) {
    if (/[?&]lang=/.test(path)) { return path; }
    return path + (path.indexOf('?') < 0 ? '?' : '&') + 'lang=' + lang;
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json' };
    var hasBody = opts.body !== undefined && opts.body !== null;
    if (hasBody) { headers['Content-Type'] = 'application/json'; }
    var token = getToken();
    if (token) { headers.Authorization = 'Bearer ' + token; }

    return fetch(withLang(path), {
      method: opts.method || (hasBody ? 'POST' : 'GET'),
      headers: headers,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      credentials: 'omit'
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch (e) { data = null; }
        }
        if (res.ok) { return data || {}; }
        var err = new Error((data && data.message) || (data && data.error) || ('HTTP ' + res.status));
        err.status = res.status;
        err.code = (data && data.error) || '';
        err.serverMessage = (data && data.message) || '';
        err.data = data;
        if (res.status === 401 && token && opts.useToken) { clearToken(); }
        throw err;
      });
    }, function () {
      var err = new Error('network');
      err.status = 0;
      err.code = 'network';
      throw err;
    });
  }

  /* ============================================================= validators */

  function digitsOnly(value) { return String(value || '').replace(/[^0-9]/g, ''); }

  /* /api/config publishes the digit laws the server enforces; these are the same numbers so a
     form can never accept a credential the API is going to reject anyway. */
  var KYC = { phoneDigits: 10, idDigits: 16, tinDigits: 9 };

  function exactlyDigits(raw, count) {
    var value = String(raw || '').replace(/[ -]/g, '');
    return /^[0-9]+$/.test(value) && value.length === count;
  }

  function normalizePhone(value) {
    var d = digitsOnly(value);
    if (d.indexOf('00250') === 0) { d = d.slice(5); }
    else if (d.indexOf('250') === 0 && d.length === 12) { d = d.slice(3); }
    /* a driver who types 788123456 means 0788123456 */
    if (d.length === 9 && d.charAt(0) === '7') { d = '0' + d; }
    return d;
  }

  function isPhone(value) { return /^07[2-9][0-9]{7}$/.test(normalizePhone(value)); }
  function isIdNumber(value) { return exactlyDigits(value, KYC.idDigits); }
  function isTin(value) { return exactlyDigits(value, KYC.tinDigits); }

  function normalizePlate(value) {
    return String(value || '').toUpperCase().replace(/[\s_-]+/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
  }

  function isPlate(value) {
    var v = normalizePlate(value);
    var tight = v.replace(/ /g, '');
    return /^[A-Z]{2,3}[0-9]{2,4}[A-Z]?$/.test(tight) || /^[A-Z]{2,3} [0-9]{2,4} [A-Z]$/.test(v);
  }

  /* The same shape the server accepts: one @, one dot in the domain, nothing else surprising.
     The server lowercases the address itself, so two spellings of one mailbox are one account. */
  function isEmail(value) {
    var v = String(value || '').trim();
    return v.length <= 120 && /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(v);
  }

  function cleanNames(value) {
    return String(value || '').replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  function isNames(value) {
    var v = cleanNames(value);
    return v.length >= 3 && v.length <= 80;
  }

  function telHref(phone) {
    var d = normalizePhone(phone);
    return 'tel:+250' + d.slice(1);
  }

  /* ============================================================ dashboard bits */

  function group3(value) {
    var s = String(Math.round(Number(value) || 0));
    var sign = s.charAt(0) === '-' ? '-' : '';
    if (sign) { s = s.slice(1); }
    return sign + s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  /* RWF never uses decimals on SERE Moto, so every money string is one call away. */
  function rwf(value) {
    if (value === null || value === undefined || value === '') { return '—'; }
    return group3(value) + ' RWF';
  }

  function num(value) {
    if (value === null || value === undefined || value === '') { return '—'; }
    return group3(value);
  }

  function km(value) {
    if (!value) { return '—'; }
    return t('tp.km', { n: Math.round(Number(value) * 10) / 10 });
  }

  function initials(name) {
    var parts = String(name || '?').split(' ');
    var out = '';
    for (var i = 0; i < parts.length && out.length < 2; i++) {
      if (parts[i]) { out += parts[i].charAt(0); }
    }
    return esc(out.toUpperCase() || '?');
  }

  /* SQLite stamps arrive as "2026-11-02 18:41:07"; the slab only has room for the tail. */
  function stamp(value) {
    var s = String(value || '');
    return s.length > 16 ? s.slice(0, 16) : s;
  }

  function since(iso) {
    var raw = String(iso || '');
    if (!raw) { return null; }
    var ms = Date.parse(raw.replace(' ', 'T') + (/[Z+]/.test(raw) ? '' : 'Z'));
    if (isNaN(ms)) { return null; }
    return Math.max(0, Math.round((Date.now() - ms) / 1000));
  }

  function badge(status) {
    return '<span class="badge b-' + esc(status || '') + '">' +
      esc(t(TRIP_STATUS[status] || 'tp.status')) + '</span>';
  }

  function payBadge(status) {
    var label = status ? t(PAY_STATUS[status] || 'tp.payment') : t('pay.none');
    return '<span class="badge b-' + esc(status || 'none') + '">' + esc(label) + '</span>';
  }

  function stars(n) {
    var value = Math.round(Number(n) || 0);
    var out = '';
    for (var i = 1; i <= 5; i++) {
      out += '<i class="s' + (i <= value ? ' on' : '') + '" aria-hidden="true">&#9733;</i>';
    }
    return '<span class="stars">' + out + '</span>';
  }

  /* =============================================================== messaging */

  var ICON = {
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/><path d="M10.3 3.9 2.6 17.4A1.9 1.9 0 0 0 4.3 20.3h15.4a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.6h.01"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5 9.5 18 20 6.5"/></svg>',
    wait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 3.5h3l1.5 4-2 1.5a10 10 0 0 0 4.5 4.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z"/></svg>',
    moto: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="22" r="4.2"/><circle cx="23" cy="22" r="4.2"/><path d="M9 22l4-8h6l3 8"/><path d="M13 14h7"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h5M7 14h8"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13"/><path d="M12 5.5 18.5 12 12 18.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3.5 13.5h4l1.5 3h6l1.5-3h4"/><path d="M5.5 5.5h13l2 8v4.5h-17v-4.5Z"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M15 5.5 20.5 12 15 18.5"/><path d="M4 12h15"/></svg>'
  };

  /* banner inside a slab: kind = err | ok | wait | info */
  function banner(node, kind, message, iconKey) {
    if (!node) { return; }
    node.className = 'msg msg-' + kind;
    node.innerHTML = (ICON[iconKey || (kind === 'err' ? 'warn' : kind === 'ok' ? 'ok' : 'info')] || '') +
      '<span>' + esc(message) + '</span>';
    visible(node, true);
  }

  function hideBanner(node) {
    if (node) { node.hidden = true; node.innerHTML = ''; }
  }

  function fieldError(host, message) {
    if (!host) { return; }
    var box = q('.err', host);
    var input = q('input, select, textarea', host);
    if (message) {
      host.classList.add('bad');
      host.classList.remove('good');
      if (box) { box.innerHTML = ICON.warn + '<span>' + esc(message) + '</span>'; visible(box, true); }
      if (input) { input.setAttribute('aria-invalid', 'true'); }
    } else {
      host.classList.remove('bad');
      if (box) { visible(box, false); box.innerHTML = ''; }
      if (input) { input.removeAttribute('aria-invalid'); }
    }
  }

  function fieldGood(host, ok) {
    if (!host) { return; }
    if (ok) { host.classList.add('good'); } else { host.classList.remove('good'); }
  }

  /* ================================================================ google */

  var googleLoaded = false;

  function loadGscript(clientId, onReady) {
    if (googleLoaded && window.google && window.google.accounts && window.google.accounts.id) {
      onReady();
      return;
    }
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = function () {
      googleLoaded = true;
      if (window.google && window.google.accounts && window.google.accounts.id && clientId) {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: function (resp) { onReady(resp.credential); }
        });
      }
      onReady(null);
    };
    s.onerror = function () { onReady(null); };
    document.head.appendChild(s);
  }

  /* slot = the div we render the GSI button into; called only when clientId is real */
  function mountGoogle(slot, clientId, onCredential) {
    if (!slot || !clientId) { return; }
    loadGscript(clientId, function (credential) {
      if (credential) { onCredential(credential); return; }
      if (window.google && window.google.accounts && window.google.accounts.id && clientId) {
        window.google.accounts.id.renderButton(slot, {
          theme: 'outline', size: 'large', width: 300, text: 'continue_with', locale: lang === 'rw' ? 'en' : 'en'
        });
      }
    });
  }

  /* ============================================================ query string */

  function param(name) {
    var search = String(location.search || '').replace(/^\?/, '');
    var parts = search.split('&');
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i].split('=');
      if (decodeURIComponent(pair[0]) === name) {
        return decodeURIComponent((pair[1] || '').replace(/\+/g, ' '));
      }
    }
    return '';
  }

  /* ============================================================ config load */

  function loadConfig() {
    return api('/api/config').then(function (data) {
      var kyc = (data && data.kyc) || {};
      var docs = (data && data.documents) || {};
      if (kyc.phoneDigits) { KYC.phoneDigits = kyc.phoneDigits; }
      if (kyc.idDigits) { KYC.idDigits = kyc.idDigits; }
      if (kyc.tinDigits) { KYC.tinDigits = kyc.tinDigits; }
      return {
        googleClientId: data && data.googleClientId ? data.googleClientId : null,
        passwordMin: kyc.passwordMin || 8,
        /* the licence row only makes sense when there is a bucket to put the file in */
        documents: { configured: Boolean(docs.configured), maxBytes: docs.maxBytes || 8 * 1048576 },
        kyc: {
          rra: Boolean(kyc.rra),
          id: Boolean(kyc.id),
          digits: { phone: KYC.phoneDigits, id: KYC.idDigits, tin: KYC.tinDigits },
        },
      };
    }, function () {
      return {
        googleClientId: null, passwordMin: 8,
        documents: { configured: false, maxBytes: 8 * 1048576 },
        kyc: { rra: false, id: false, digits: { phone: 10, id: 16, tin: 9 } },
      };
    });
  }

  /* ================================================================= LOGIN */

  function initLogin() {
    var els = {
      stPhone: q('#stPhone'),
      stWait: q('#stWait'),
      stReject: q('#stReject'),
      stOk: q('#stOk'),
      email: q('#inEmail'),
      emailField: q('#fldEmail'),
      pass: q('#inPass'),
      passField: q('#fldPass'),
      btnSend: q('#btnSend'),
      sendMsg: q('#sendMsg'),
      frmPhone: q('#frmPhone'),
      waitTitle: q('#waitTitle'),
      waitBody: q('#waitBody'),
      rejBody: q('#rejBody'),
      rejReason: q('#rejReason'),
      googleBox: q('#googleBox'),
      gsiSlot: q('#gsiSlot'),
      okName: q('#okName')
    };

    var state = { submitting: false, passwordMin: 8 };
    var view = { which: 'stPhone', data: null };

    /* A rider who has not filed the form yet has no name on the account, so every greeting falls
       back to the address they signed in with. */
    function who(data) {
      var d = data.driver || {};
      return d.name || d.names || d.email || '';
    }

    function paintState() {
      var data = view.data || {};
      if (view.which === 'stWait') {
        text(els.waitTitle, t('lg.waitTitle'));
        text(els.waitBody, t('lg.waitBody', { name: who(data) }));
      }
      if (view.which === 'stReject') {
        text(els.rejBody, t('lg.rejBody'));
        text(els.rejReason, data.reason || '');
        visible(els.rejReason, !!data.reason);
      }
      if (view.which === 'stOk') {
        text(els.okName, who(data));
      }
    }

    function show(which, data) {
      view.which = which;
      view.data = data || null;
      ['stPhone', 'stWait', 'stReject', 'stOk'].forEach(function (k) {
        visible(els[k], k === which);
      });
      paintState();
    }

    /* The server says what this account is allowed to do next. A draft keeps its token because the
       rider is about to fill in the details form, which is fenced behind that very session. */
    function route(data) {
      if (data.status === 'approved') {
        setToken(data.token);
        show('stOk', data);
        window.setTimeout(function () { location.href = '/rider'; }, 700);
        return;
      }
      if (data.status === 'draft') {
        setToken(data.token);
        location.href = '/signup';
        return;
      }
      if (data.status === 'pending') { show('stWait', data); return; }
      if (data.status === 'rejected') { show('stReject', data); return; }
      show('stPhone');
      banner(els.sendMsg, 'err', t('c.loading'));
    }

    function enter() {
      var email = String(els.email.value || '').trim().toLowerCase();
      var pass = String(els.pass.value || '');
      var bad = false;
      if (!isEmail(email)) { fieldError(els.emailField, t('su.errEmail')); bad = true; }
      else { fieldError(els.emailField, ''); }
      if (pass.length < state.passwordMin) { fieldError(els.passField, t('su.errPass')); bad = true; }
      else { fieldError(els.passField, ''); }
      if (bad) {
        (isEmail(email) ? els.pass : els.email).focus();
        return;
      }
      if (state.submitting) { return; }
      hideBanner(els.sendMsg);
      state.submitting = true;
      loading(els.btnSend, true);
      api('/api/auth/login', { body: { email: email, password: pass } }).then(function (data) {
        state.submitting = false;
        loading(els.btnSend, false);
        route(data);
      }, function (err) {
        state.submitting = false;
        loading(els.btnSend, false);
        if (err.code === 'invalid_email') { fieldError(els.emailField, errText(err)); }
        if (err.code === 'invalid_password') { fieldError(els.passField, errText(err)); }
        if (err.code === 'google_account_only') { els.email.focus(); }
        banner(els.sendMsg, 'err', errText(err));
      });
    }

    if (els.frmPhone) {
      els.frmPhone.addEventListener('submit', function (ev) { ev.preventDefault(); enter(); });
    }
    [els.email, els.pass].forEach(function (input) {
      input.addEventListener('input', function () {
        fieldError(els.emailField, '');
        fieldError(els.passField, '');
        hideBanner(els.sendMsg);
      });
    });

    /* google is only mounted when the server actually advertises a client id */
    loadConfig().then(function (cfg) {
      state.passwordMin = cfg.passwordMin;
      if (cfg.googleClientId) {
        visible(els.googleBox, true);
        mountGoogle(els.gsiSlot, cfg.googleClientId, function (credential) {
          if (!credential) { return; }
          api('/api/auth/google', { body: { credential: credential } }).then(function (data) {
            if (data.status === 'new') {
              location.href = '/signup?google_token=' + encodeURIComponent(data.googleToken || '') +
                '&name=' + encodeURIComponent(data.name || '') +
                '&email=' + encodeURIComponent(data.email || '');
              return;
            }
            route(data);
          }, function (err) {
            visible(els.googleBox, true);
            banner(els.sendMsg, 'err', errText(err));
          });
        });
      }
    });

    onLang(paintState);

    show('stPhone');
    if (getToken()) { visible(q('#alreadyIn'), true); }
  }

  /* ================================================================ SIGNUP */

  function initSignup() {
    var els = {
      stAccount: q('#stAccount'),
      stForm: q('#stForm'),
      stDone: q('#stDone'),
      stepLede: q('#stepLede'),
      email: q('#inEmail'),
      emailField: q('#fldEmail'),
      pass: q('#inPass'),
      passField: q('#fldPass'),
      passHint: q('#passHint'),
      btnAccount: q('#btnAccount'),
      acctMsg: q('#acctMsg'),
      frmAccount: q('#frmAccount'),
      googleBox: q('#googleBox'),
      gsiSlot: q('#gsiSlot'),
      googleNote: q('#googleNote'),
      names: q('#inNames'),
      fldNames: q('#fldNames'),
      id: q('#inId'),
      fldId: q('#fldId'),
      tin: q('#inTin'),
      fldTin: q('#fldTin'),
      plate: q('#inPlate'),
      fldPlate: q('#fldPlate'),
      phone: q('#inPhone'),
      fldPhone: q('#fldPhone'),
      seg: q('#segType'),
      tinState: q('#tinState'),
      idState: q('#idState'),
      kycHint: q('#kycHint'),
      licRow: q('#fldLic'),
      btnLic: q('#btnLic'),
      inLic: q('#inLic'),
      licName: q('#licName'),
      licState: q('#licState'),
      btnSubmit: q('#btnSubmit'),
      formMsg: q('#formMsg'),
      doneSum: q('#doneSum'),
      doneNote: q('#doneNote')
    };

    var state = {
      vehicle: 'moto',
      googleToken: param('google_token'),
      google: Boolean(param('google_token')),
      email: '',
      passwordMin: 8,
      docs: { configured: false, maxBytes: 8 * 1048576 },
      licence: null,
      cap: { rra: false, id: false },
      checks: { tin: null, id: null },
      running: { tin: '', id: '' },
      signing: false,
      filing: false
    };

    /* --------------------------------------------------------------- steps */

    function showStep(which) {
      visible(els.stAccount, which === 'stAccount');
      visible(els.stForm, which === 'stForm');
      visible(els.stDone, which === 'stDone');
      text(els.stepLede, t(which === 'stAccount' ? 'su.lede' : 'su.lede2'));
    }

    /* ------------------------------------------------------------ fields */

    function checkField(which, silent) {
      var map = {
        names: { host: els.fldNames, input: els.names, ok: isNames(els.names.value), msg: t('su.errNames') },
        id: { host: els.fldId, input: els.id, ok: isIdNumber(els.id.value), msg: t('su.errId') },
        tin: { host: els.fldTin, input: els.tin, ok: isTin(els.tin.value), msg: t('su.errTin') },
        plate: { host: els.fldPlate, input: els.plate, ok: isPlate(els.plate.value), msg: t('su.errPlate') },
        phone: { host: els.fldPhone, input: els.phone, ok: isPhone(els.phone.value), msg: t('su.errPhone') }
      };
      var item = map[which];
      if (!item) { return true; }
      var empty = !String(item.input.value || '').replace(/\s/g, '');
      if (empty && silent) { fieldError(item.host, ''); fieldGood(item.host, false); return false; }
      fieldError(item.host, item.ok ? '' : item.msg);
      fieldGood(item.host, item.ok);
      return item.ok;
    }

    function validAll() {
      var ok = true;
      ['names', 'id', 'tin', 'plate', 'phone'].forEach(function (k) {
        if (!checkField(k, false)) { ok = false; }
      });
      return ok;
    }

    /* ------------------------------------------------- RRA / NIDA verdicts
       Both lookups run on the rider's own session now: the account is the budget key, so nobody can
       drive the registers from a script. A register that does not know the number is red; a lookup
       that could not be made is grey — "not found" and "not asked" are not the same fact. */

    var KYC_WRONG = {
      tin_not_found: 1, id_not_found: 1, id_name_mismatch: 1,
      invalid_tin_number: 1, invalid_id_number: 1, invalid_names: 1
    };

    function kycDigits(which) {
      return String((which === 'tin' ? els.tin.value : els.id.value) || '').replace(/[ -]/g, '');
    }

    function kycWords(which, verdict) {
      if (verdict.kind !== 'ok') { return ecOf(verdict.code, verdict.server); }
      if (which === 'tin') { return verdict.name ? t('su.tinOkName', { name: verdict.name }) : t('su.tinOk'); }
      return verdict.match ? t('su.idOkName') : t('su.idOk');
    }

    function kycPaint(which) {
      var line = which === 'tin' ? els.tinState : els.idState;
      var verdict = state.checks[which];
      if (!line) { return; }
      if (!verdict) { line.hidden = true; line.innerHTML = ''; return; }
      if (verdict.busy) {
        line.className = 'kycline info';
        line.innerHTML = '<span class="dot" aria-hidden="true"></span><span>' +
          esc(t(which === 'tin' ? 'su.tinChecking' : 'su.idChecking')) + '</span>';
        line.hidden = false;
        return;
      }
      line.className = 'kycline' + (verdict.kind === 'bad' ? ' bad' : verdict.kind === 'info' ? ' info' : '');
      line.innerHTML = (verdict.kind === 'ok' ? ICON.ok : verdict.kind === 'bad' ? ICON.warn : ICON.info) +
        '<span>' + esc(kycWords(which, verdict)) + '</span>' +
        '<button class="mini" type="button" data-kyc="' + which + '">' + esc(t('su.checkAgain')) + '</button>';
      line.hidden = false;
      fieldGood(which === 'tin' ? els.fldTin : els.fldId, verdict.kind === 'ok');
    }

    function kycRun(which, force) {
      if (!getToken() || !(which === 'tin' ? state.cap.rra : state.cap.id)) { return; }
      var value = kycDigits(which);
      var wellFormed = which === 'tin' ? isTin(value) : isIdNumber(value);
      if (!wellFormed) { state.checks[which] = null; kycPaint(which); return; }
      if (!force && state.running[which] === value) { return; }
      state.running[which] = value;
      state.checks[which] = { busy: true };
      kycPaint(which);
      var body = which === 'tin'
        ? { tin_number: value }
        : { id_number: value, names: cleanNames(els.names.value) };
      if (force) { body.force = true; }
      api(which === 'tin' ? '/api/verify-tin' : '/api/verify-id', {
        body: body, useToken: true
      }).then(function (data) {
        if (state.running[which] !== value) { return; }
        state.checks[which] = which === 'tin'
          ? { kind: data.valid ? 'ok' : 'bad', name: String(data.taxpayer || '').slice(0, 60), code: 'tin_not_found' }
          : { kind: data.exists && data.match ? 'ok' : 'bad', match: Boolean(data.match), code: data.exists ? 'id_name_mismatch' : 'id_not_found' };
        kycPaint(which);
      }, function (err) {
        if (state.running[which] !== value) { return; }
        state.running[which] = '';
        state.checks[which] = { kind: KYC_WRONG[err.code] ? 'bad' : 'info', code: err.code, server: err.serverMessage };
        kycPaint(which);
      });
    }

    function kycLimits(kyc) {
      if (els.tin) { els.tin.setAttribute('maxlength', String(kyc.digits.tin)); }
      if (els.id) { els.id.setAttribute('maxlength', String(kyc.digits.id)); }
      if (els.kycHint) { visible(els.kycHint, !!(state.cap.rra || state.cap.id)); }
    }

    /* ------------------------------------------------------- trading licence
       The paper a moto operator gets from the district office. It arrives as a PDF, goes straight to
       the private bucket, and the server only asks for it once the bucket actually exists. */

    var LIC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

    function licPaint(verdict) {
      var line = els.licState;
      if (!line) { return; }
      if (!verdict) { line.hidden = true; line.innerHTML = ''; return; }
      if (verdict.busy) {
        line.className = 'kycline info';
        line.innerHTML = '<span class="dot" aria-hidden="true"></span><span>' + esc(t('su.licenceUploading')) + '</span>';
        line.hidden = false;
        return;
      }
      line.className = 'kycline' + (verdict.kind === 'bad' ? ' bad' : '');
      line.innerHTML = (verdict.kind === 'bad' ? ICON.warn : ICON.ok) + '<span>' + esc(verdict.text) + '</span>';
      line.hidden = false;
    }

    function uploadLicence() {
      var file = els.inLic.files && els.inLic.files[0];
      els.inLic.value = '';
      if (!file) { return; }
      text(els.licName, file.name);
      if (LIC_TYPES.indexOf(file.type) < 0) {
        state.licence = null;
        licPaint({ kind: 'bad', text: t('su.licenceType') });
        return;
      }
      if (file.size > state.docs.maxBytes) {
        state.licence = null;
        licPaint({ kind: 'bad', text: t('su.licenceSize', { n: Math.round(state.docs.maxBytes / 1048576) }) });
        return;
      }
      state.licence = null;
      licPaint({ busy: true });
      if (els.btnLic) { els.btnLic.disabled = true; }
      api('/api/drivers/me/documents/trading_licence/upload-url', {
        method: 'POST', body: { content_type: file.type }, useToken: true
      }).then(function (ticket) {
        return fetch(ticket.uploadUrl, {
          method: 'PUT', headers: { 'Content-Type': file.type }, body: file
        }).then(function (res) {
          if (!res.ok) {
            var failure = new Error('upload');
            failure.code = 'document_not_uploaded';
            throw failure;
          }
          return api('/api/drivers/me/documents/trading_licence/complete', { method: 'POST', useToken: true });
        });
      }).then(function (data) {
        if (els.btnLic) { els.btnLic.disabled = false; }
        state.licence = data.document;
        var kb = Math.max(1, Math.round((data.document.bytes || file.size) / 1024));
        licPaint({ kind: 'ok', text: t('su.licenceDone') + ' · ' + kb + ' KB' });
        hideBanner(els.formMsg);
      }, function (err) {
        if (els.btnLic) { els.btnLic.disabled = false; }
        state.licence = null;
        licPaint({ kind: 'bad', text: errText(err) });
      });
    }

    /* ------------------------------------------------------------- step 1 */

    function createAccount(google) {
      var email = String(els.email.value || '').trim().toLowerCase();
      var passphrase = String(els.pass.value || '');
      if (!isEmail(email)) {
        fieldError(els.emailField, t('su.errEmail'));
        els.email.focus();
        return;
      }
      fieldError(els.emailField, '');
      if (!google) {
        if (passphrase.length < state.passwordMin) {
          fieldError(els.passField, t('su.errPass'));
          els.pass.focus();
          return;
        }
        fieldError(els.passField, '');
      }
      if (state.signing) { return; }
      state.signing = true;
      hideBanner(els.acctMsg);
      loading(els.btnAccount, true);
      var body = { email: email };
      if (google) { body.google_token = state.googleToken; }
      else { body.password = passphrase; }
      api('/api/auth/signup', { body: body }).then(function (data) {
        state.signing = false;
        loading(els.btnAccount, false);
        /* a draft account keeps its token: the details form is fenced behind this very session */
        setToken(data.token);
        state.email = email;
        state.googleToken = '';
        enterForm();
      }, function (err) {
        state.signing = false;
        loading(els.btnAccount, false);
        if (err.code === 'invalid_email' || err.code === 'email_taken') { fieldError(els.emailField, errText(err)); }
        if (err.code === 'invalid_password') { fieldError(els.passField, errText(err)); }
        banner(els.acctMsg, 'err', errText(err));
      });
    }

    /* ------------------------------------------------------------- step 2 */

    function enterForm() {
      showStep('stForm');
      visible(els.licRow, Boolean(state.docs.configured));
      visible(els.googleNote, state.google);
      window.scrollTo(0, 0);
      kycRun('tin');
      kycRun('id');
      if (els.names && !els.names.value) { els.names.focus(); }
    }

    function fileApplication() {
      if (!validAll()) { return; }
      if (state.docs.configured && !state.licence) {
        banner(els.formMsg, 'err', ecOf('licence_required'));
        if (els.btnLic) { els.btnLic.focus(); }
        return;
      }
      if (state.filing) { return; }
      hideBanner(els.formMsg);
      var body = {
        names: cleanNames(els.names.value),
        id_number: String(els.id.value || '').replace(/[ -]/g, ''),
        tin_number: String(els.tin.value || '').replace(/[ -]/g, ''),
        plate: normalizePlate(els.plate.value),
        phone: normalizePhone(els.phone.value),
        vehicle_type: state.vehicle
      };
      state.filing = true;
      loading(els.btnSubmit, true);
      api('/api/auth/details', { body: body, useToken: true }).then(function (data) {
        state.filing = false;
        loading(els.btnSubmit, false);
        paintDone(data.application || body);
        showStep('stDone');
        window.scrollTo(0, 0);
      }, function (err) {
        state.filing = false;
        loading(els.btnSubmit, false);
        var fieldMap = {
          invalid_names: els.fldNames, invalid_id_number: els.fldId, invalid_tin_number: els.fldTin,
          invalid_plate: els.fldPlate, invalid_phone: els.fldPhone, phone_invalid: els.fldPhone,
          invalid_vehicle_type: null, id_number_taken: els.fldId, tin_number_taken: els.fldTin,
          plate_taken: els.fldPlate
        };
        var host = Object.prototype.hasOwnProperty.call(fieldMap, err.code) ? fieldMap[err.code] : undefined;
        if (host) { fieldError(host, errText(err)); }
        if (err.code === 'licence_required' && els.btnLic) { els.btnLic.focus(); }
        if (err.code === 'authentication_required') { clearToken(); showStep('stAccount'); }
        if (err.code === 'details_already_filed') {
          api('/api/auth/me').then(function (data) {
            paintDone(data.driver || {});
            showStep('stDone');
          }, function () { banner(els.formMsg, 'err', errText(err)); });
          return;
        }
        banner(els.formMsg, 'err', errText(err));
      });
    }

    function paintDone(app) {
      els.doneSum.innerHTML = t('su.doneSum', {
        names: esc(app.name || app.names || ''),
        plate: esc(app.plate || ''),
        phone: esc(app.phone || '')
      });
      els.doneNote.innerHTML = t('su.doneNote', { email: esc(state.email || app.email || '') });
    }

    /* ------------------------------------------------------------ wiring */

    if (els.frmAccount) {
      els.frmAccount.addEventListener('submit', function (ev) { ev.preventDefault(); createAccount(false); });
    }
    [els.email, els.pass].forEach(function (input) {
      input.addEventListener('input', function () {
        fieldError(els.emailField, '');
        fieldError(els.passField, '');
        hideBanner(els.acctMsg);
      });
    });

    if (els.btnLic) {
      els.btnLic.addEventListener('click', function (ev) { ev.preventDefault(); els.inLic.click(); });
    }
    if (els.inLic) { els.inLic.addEventListener('change', uploadLicence); }

    qa('input[name="vtype"]', els.seg).forEach(function (radio) {
      radio.addEventListener('change', function () {
        state.vehicle = radio.value;
        qa('.choice-opt', els.seg).forEach(function (row) {
          row.className = 'choice-opt' + (row.contains(radio) && radio.checked ? ' on' : '');
        });
      });
    });

    els.btnSubmit.addEventListener('click', function (ev) { ev.preventDefault(); fileApplication(); });

    ['names', 'id', 'tin', 'plate', 'phone'].forEach(function (k) {
      var input = { names: els.names, id: els.id, tin: els.tin, plate: els.plate, phone: els.phone }[k];
      var host = { names: els.fldNames, id: els.fldId, tin: els.fldTin, plate: els.fldPlate, phone: els.fldPhone }[k];
      var lookups = k === 'id' || k === 'tin';
      input.addEventListener('blur', function () {
        checkField(k, false);
        if (lookups) { kycRun(k); }
        if (k === 'names' && state.checks.id) { kycRun('id', true); }
      });
      input.addEventListener('input', function () {
        fieldError(host, '');
        hideBanner(els.formMsg);
        if (lookups) { state.checks[k] = null; state.running[k] = ''; kycPaint(k); }
      });
    });

    if (els.stForm) {
      els.stForm.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-kyc]') : null;
        if (!btn) { return; }
        ev.preventDefault();
        kycRun(btn.getAttribute('data-kyc'), true);
      });
    }

    /* google never fills the password box: the address it vouches for is the whole credential */
    if (state.googleToken) {
      els.email.value = String(param('email') || '').toLowerCase();
    }

    loadConfig().then(function (cfg) {
      state.passwordMin = cfg.passwordMin;
      state.docs = cfg.documents;
      text(els.passHint, t('su.passHint', { n: cfg.passwordMin }));
      state.cap = cfg.kyc;
      kycLimits(cfg.kyc);
      if (cfg.googleClientId) {
        visible(els.googleBox, true);
        mountGoogle(els.gsiSlot, cfg.googleClientId, function (credential) {
          if (!credential) { return; }
          api('/api/auth/google', { body: { credential: credential } }).then(function (data) {
            if (data.status === 'new') {
              els.email.value = String(data.email || '').toLowerCase();
              state.googleToken = data.googleToken || '';
              state.google = true;
              createAccount(true);
              return;
            }
            /* the address already belongs to a rider — send them where their account actually is */
            setToken(data.token);
            afterSession(data);
          }, function (err) {
            banner(els.acctMsg, 'err', errText(err));
          });
        });
      }
      openSession();
    });

    /* ---------------------------- where does the session this page holds go? */

    function afterSession(data) {
      var d = data.driver || data || {};
      state.email = d.email || state.email;
      if (d.status === 'approved') { location.href = '/rider'; return; }
      if (d.status === 'pending' || d.status === 'rejected') {
        /* the application is out of this page's hands — /login owns those two states */
        clearToken();
        location.href = '/login';
        return;
      }
      var preName = param('name');
      if (preName && !els.names.value) { els.names.value = preName; }
      enterForm();
    }

    function openSession() {
      /* a Google handshake is a brand-new account: never let an old token decide this page's step */
      if (state.googleToken) { clearToken(); createAccount(true); return; }
      if (!getToken()) { showStep('stAccount'); return; }
      api('/api/auth/me').then(function (data) {
        afterSession(data);
      }, function (err) {
        clearToken();
        showStep('stAccount');
        if (err.code !== 'authentication_required') { banner(els.acctMsg, 'err', errText(err)); }
      });
    }

    onLang(function () {
      ['names', 'id', 'tin', 'plate', 'phone'].forEach(function (k) {
        var host = { names: els.fldNames, id: els.fldId, tin: els.fldTin, plate: els.fldPlate, phone: els.fldPhone }[k];
        if (host && host.classList.contains('bad')) { checkField(k, false); }
      });
      kycPaint('tin');
      kycPaint('id');
      text(els.passHint, t('su.passHint', { n: state.passwordMin }));
    });

    showStep('stAccount');
  }

  /* ================================================================ app bar
     The same chrome the app uses, so signing up or administering never looks
     like a different product. Injected before applyLang so the bar is translated. */

  var AB = {
    logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="10" cy="22" r="4.4" fill="#fff"/><circle cx="23" cy="22" r="4.4" fill="#fff"/><path d="M10 22l4-8h6l3 8" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M14 14h7" stroke="#f6c17a" stroke-width="2.6" stroke-linecap="round"/></svg>',
    bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h11"/></svg>',
    account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>',
    find: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
    join: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="8" r="4"/><path d="M3 20.5a7 7 0 0 1 14 0"/><path d="M18 8.5v5M15.5 11h5"/></svg>',
    mine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3.5 13.5 6 5h12l2.5 8.5"/><path d="M3.5 13.5h5l1 2.5h5l1-2.5h5v4a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 17.5Z"/></svg>',
    guide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 6.5A4 4 0 1 0 8.4 12"/><circle cx="12" cy="12" r="9"/></svg>',
    admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3.5 5 6v6c0 4 3 6.7 7 8.5 4-1.8 7-4.5 7-8.5V6Z"/><path d="M9 12l2.2 2.2L15.5 10"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 4v10"/><path d="M8 11l4 3.5L16 11"/><path d="M5 19h14"/></svg>'
  };

  var AB_LINKS = [
    ['/', 'ab.find', 'Passenger', 'find'],
    ['/signup', 'ab.join', 'Rider', 'join'],
    ['/passenger', 'ab.mine', 'Ibyange', 'mine'],
    ['/rider', 'ab.rider', 'Urubuga rw\'umumotari', 'account'],
    ['/guide', 'ab.guide', 'Uko bikora', 'guide']
  ];

  function appBarHtml(current) {
    var nav = AB_LINKS.slice(0, 3).map(function (l, i) {
      var now = current === l[1] ? ' aria-current="page"' : '';
      if (i === 2) {
        return '<a class="ab-tab ab-tab-icon" id="abAccountLink" href="' + l[0] + '" data-i18n-title="' + l[1] +
          '" title="' + l[2] + '" aria-label="' + l[2] + '"' + now + '>' + AB.account + '</a>';
      }
      return '<a class="ab-tab" href="' + l[0] + '"' + now + '><span data-i18n="' + l[1] + '">' + l[2] + '</span></a>';
    }).join('');

    var rows = AB_LINKS.map(function (l) {
      var target = l[0] === '/guide' ? ' target="_blank" rel="noopener"' : '';
      return '<li><a href="' + l[0] + '"' + target + '>' + AB[l[3]] +
        '<span data-i18n="' + l[1] + '">' + l[2] + '</span></a></li>';
    }).join('') +
      '<li id="abAdminRow" hidden><a href="/admin">' + AB.admin +
      '<span data-i18n="ab.admin">Ubuyobozi</span></a></li>' +
      '<li id="abInstallRow" hidden><button class="ab-row" type="button" id="abInstall">' + AB.down +
      '<span data-i18n="ab.install">Shyira app kuri Phone</span></button></li>';

    return '<div class="ab-in">' +
      '<a class="ab-logo" href="/" aria-label="SEREMOTO">' + AB.logo +
      '<div><b>SEREMOTO</b><span data-i18n="ab.tagline">Transport &amp; clients</span></div></a>' +
      '<nav class="ab-nav">' + nav +
      '<button class="ab-tab ab-tab-icon" id="abMenu" type="button" aria-haspopup="true" aria-expanded="false"' +
      ' aria-controls="abMenuPanel" data-i18n-title="ab.menu" title="Menu" aria-label="Menu">' + AB.bars + '</button>' +
      '<span class="lang" role="group" aria-label="Language">' +
      '<button type="button" data-lang="rw" aria-pressed="true">RW</button>' +
      '<button type="button" data-lang="en" aria-pressed="false">EN</button></span>' +
      '</nav>' +
      '<div class="ab-menu" id="abMenuPanel" role="group" aria-label="Menu" hidden>' +
      '<h4 data-i18n="ab.app">Porogaramu</h4><ul>' + rows + '</ul>' +
      '</div></div>';
  }

  function mountAppBar(current) {
    var host = q('#appbar');
    if (!host) { return; }
    host.className = 'appbar';
    host.innerHTML = appBarHtml(current);

    var panel = q('#abMenuPanel', host);
    var btn = q('#abMenu', host);
    var install = q('#abInstall', host);
    var installRow = q('#abInstallRow', host);
    var deferred = null;
    var open = false;

    function setOpen(next) {
      open = next;
      panel.hidden = !next;
      btn.setAttribute('aria-expanded', String(next));
      if (next) {
        panel.style.maxHeight = Math.max(180, window.innerHeight - panel.getBoundingClientRect().top - 8) + 'px';
      }
    }
    btn.addEventListener('click', function () { setOpen(!open); });
    document.addEventListener('click', function (e) {
      if (!open || !e.isTrusted) { return; }
      if (panel.contains(e.target) || btn.contains(e.target)) { return; }
      setOpen(false);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { setOpen(false); } });
    qa('.ab-menu a', host).forEach(function (a) { a.addEventListener('click', function () { setOpen(false); }); });

    function standalone() {
      return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    }
    function paintInstall() {
      var span = install.querySelector('span');
      if (standalone()) {
        span.textContent = t('ab.installed');
        install.disabled = true;
        installRow.hidden = false;
        return;
      }
      span.textContent = t('ab.install');
      install.disabled = false;
      installRow.hidden = !deferred;
    }
    install.addEventListener('click', function () {
      if (!deferred) { return; }
      var promptEvent = deferred;
      install.disabled = true;
      promptEvent.prompt().catch(function () {}).then(function () { return promptEvent.userChoice; })
        .catch(function () {}).then(function () { deferred = null; paintInstall(); });
    });
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferred = e;
      paintInstall();
    });
    window.addEventListener('appinstalled', function () { deferred = null; paintInstall(); });
    paintInstall();
    onLang(paintInstall);

    if ('serviceWorker' in navigator && !navigator.serviceWorker.controller) {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    }
    if (!getToken()) { return; }
    /* The session call answers for both kinds of account, so a passenger's token is
       never treated as a failed driver login and thrown away. */
    api('/api/auth/session').then(function (data) {
      var kind = data && data.kind;
      var account = q('#abAccountLink', host);
      if (kind === 'driver' && account) { account.href = '/rider'; }
      var me = kind === 'driver' ? data.driver : null;
      q('#abAdminRow', host).hidden = !(me && me.isAdmin);
    }, function () { /* no usable session — the extra rows stay hidden */ });
  }

  /* ================================================================= boot */

  /* A dashboard page keeps its own controller file and registers it here, so the
     shared library stays about chrome, language and the API. */
  var PAGE_CONTROLLERS = {};
  var bootedPage = null;

  function runPage() {
    if (bootedPage && PAGE_CONTROLLERS[bootedPage]) { PAGE_CONTROLLERS[bootedPage](); }
  }

  function onPage(name, fn) {
    PAGE_CONTROLLERS[name] = fn;
    runPage();
  }

  var AB_CURRENT = { login: 'ab.join', signup: 'ab.join', rider: 'ab.mine', passenger: 'ab.mine', admin: 'ab.mine' };

  function boot() {
    var rights = q('#rights');
    function paintRights() {
      if (rights) { text(rights, t('c.footRights', { y: new Date().getFullYear() })); }
    }
    var page = document.body.getAttribute('data-page');
    mountAppBar(AB_CURRENT[page] || null);
    wireLang();
    applyLang();
    paintRights();
    onLang(paintRights);

    bootedPage = page;
    if (page === 'login') { initLogin(); }
    else if (page === 'signup') { initSignup(); }
    runPage();
  }

  window.SERE = {
    /* language + copy */
    t: t, setLang: setLang, getLang: function () { return lang; }, onPage: onPage, onLang: onLang,
    /* DOM + api */
    q: q, qa: qa, api: api, esc: esc, text: text, visible: visible, loading: loading,
    param: param, getToken: getToken, setToken: setToken, clearToken: clearToken,
    /* messages */
    errText: errText, ecOf: ecOf, banner: banner, hideBanner: hideBanner,
    fieldError: fieldError, fieldGood: fieldGood, icons: ICON, barIcons: AB,
    /* widgets */
    loadConfig: loadConfig, mountGoogle: mountGoogle,
    /* validators */
    isPhone: isPhone, isIdNumber: isIdNumber, isTin: isTin, isPlate: isPlate,
    isNames: isNames, cleanNames: cleanNames, normalizePhone: normalizePhone,
    normalizePlate: normalizePlate, telHref: telHref, digitsOnly: digitsOnly, isEmail: isEmail,
    /* formatting */
    rwf: rwf, num: num, km: km, initials: initials, stamp: stamp, since: since,
    badge: badge, payBadge: payBadge, stars: stars, group3: group3,
    /* dictionaries the dashboards render from */
    VEHICLE: VEHICLE, SERVICES: SERVICES, STATUS_LABEL: STATUS_LABEL,
    TRIP_STATUS: TRIP_STATUS, PAY_STATUS: PAY_STATUS, KIND_LABEL: KIND_LABEL
  };

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', boot); }
  else { boot(); }
}());
