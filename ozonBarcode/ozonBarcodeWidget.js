// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-gray; icon-glyph: magic;

// This script was created by Artem Tiumentcev

const debug = false;
const baseURL = 'https://api.ozon.ru/';

let deviceID = Keychain.contains('ozonWidget_deviceID') ? Keychain.get('ozonWidget_deviceID') : generateDeviceID();

let defaultHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Accept': 'application/json; charset=UTF-8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'Keep-Alive',
    'Cache-Control': 'no-cache',
    'User-Agent': 'OzonStore/825',
    'x-o3-sdk-versions': 'ozonid_ios/6.0.1',
    'x-o3-language': 'ru',
    'x-o3-app-name': 'ozonapp_ios',
    'x-o3-app-version': '17.17.0(825)',
};

let deviceInfo = {
    "vendor": "Apple",
    "supportCountrySelect": true,
    "deviceId": deviceID,
    "os": "iOS",
    "hasBiometrics": true,
    "biometryType": "faceId",
    "model": "iPhone15,4",
    "version": Device.systemVersion(),
}

function generateDeviceID() {
    let id = '';
    let parts = [8, 4, 4, 4, 12];

    for (let i = 0; i < parts.length; i++) {
        let part = '';
        for (let j = 0; j < parts[i]; j++) {
            part += Math.floor(Math.random() * 16).toString(16);
        }
        id += part;
        if (i < parts.length - 1) {
            id += '-';
        }
    }

    return id.toLocaleUpperCase();
}

async function request(path, method, headers, data) {
    if (debug) {
        console.log('Request: ' + JSON.stringify({
            path: path,
            method: method,
            headers: headers,
            data: data
        }));
    }

    const req = new Request(baseURL + path);

    req.method = method || 'GET';
    req.headers = {...defaultHeaders, ...headers};

    if (data) {
        req.body = JSON.stringify(data)
    }

    const json = await req.loadJSON()
    if (json.error) {
        if (debug) {
            console.error(json.error);
        }

        return Promise.reject(json.error)
    }

    if (debug) {
        console.log('Response: ' + JSON.stringify(json));
    }

    return json
}

async function initPromptOTP(title) {
    const promptOTP = new Alert();

    promptOTP.title = 'Ozon';
    promptOTP.message = title || 'Введите код подтверждения';
    promptOTP.addTextField('Код подтверждения', '', '');
    promptOTP.addAction('Отправить');
    promptOTP.addCancelAction('Отмена');

    let answerOTP = await promptOTP.presentAlert();

    return [promptOTP.textFieldValue(0), answerOTP];
}

async function setupAssistant() {
    let promptInfo = new Alert()
    promptInfo.message = 'Для настройки виджета необходимо войти в личный кабинет Ozon. Перейти к настройке?'
    promptInfo.addAction('Да')
    promptInfo.addCancelAction('Нет')

    if (await promptInfo.presentAlert() === -1) {
        throw new Error('Отменено пользователем');
    }

    const promptLoginType = new Alert();

    promptLoginType.title = 'Вход в Ozon';
    promptLoginType.message = 'Выберите тип входа:';
    promptLoginType.addAction('E-mail');
    promptLoginType.addAction('Телефон');

    let loginType = await promptLoginType.presentAlert();

    // default login path for phone
    let loginPath = 'composer-api.bx/_action/ozonIdPageEntry?widgetName=csma.entryCredentialsRequired';

    if (loginType === 0) {
        console.log('Входим по E-mail...');
        loginPath = 'composer-api.bx/_action/ozonIdPageEntry?iso=RU&type=emailOtpEntry&widgetName=csma.entryCredentialsRequired';
    }

    // make a first request to get the submit button
    let json = await request(loginPath, 'POST', {}, deviceInfo);

    let submit = json.data.submitButton;
    if (!submit) {
        throw new Error('Не удалось найти кнопку входа. Сайт изменен?');
    }

    const promptLogin = new Alert();
    promptLogin.title = 'Вход в Ozon';

    if (loginType === 0) {
        promptLogin.message = 'Введите ваш E-mail';
        promptLogin.addTextField('E-mail', '', '');
    } else {
        promptLogin.message = 'Введите ваш телефон';
        promptLogin.addTextField('Телефон 7xxxxxxxxxx', '', '');
    }

    promptLogin.addAction('Войти');
    promptLogin.addCancelAction('Отмена');

    if (await promptLogin.presentAlert() === -1) {
        throw new Error('Отменено пользователем');
    }

    let login = promptLogin.textFieldValue(0);

    let reqData = {
        "deviceId": deviceID,
        "model": "iPhone15,4",
        // "connectionType": "CELLULAR_4G",
    }

    if (loginType === 0) {
        reqData.email = login;
    } else {
        reqData.phone = login;
    }

    json = await request('composer-api.bx/_action/' + submit.action, 'POST', {}, reqData);

    while (json.status && json.status.deeplink) {
        if (debug) {
            console.log('Потребовалась проверка: ' + json.status.deeplink);
        }

        json = await request('composer-api.bx/_action/' + json.status.deeplink.replace(/^ozon:\/\//, ''), 'POST');

        let otp = json.data;

        if (!otp.subtitle) {
            throw new Error(otp.title);
        }

        let [otpCode, answerOTP] = await initPromptOTP(otp.title);

        if (answerOTP === -1) {
            throw new Error('Отменено пользователем');
        }

        json = await request('composer-api.bx/_action/' + otp.action, 'POST', {}, {
            ...deviceInfo,
            ...otp.data,
            otp: otpCode
        });

        if (json.status && json.status.deeplink && (/isLongTimeNoSee=true/i.test(json.status.deeplink))) {
            // long time no see and need to check by email
            json = await request('composer-api.bx/_action/' + json.status.deeplink.replace(/^ozon:\/\//, ''));
            json = await request('composer-api.bx/_action/' + json.data.submitButton.action);
            json = await request('composer-api.bx/_action/' + json.status.deeplink.replace(/^ozon:\/\//, ''));

            otp = json.data;

            let [otpCode, answerOTP] = await initPromptOTP();
            if (answerOTP === -1) {
                throw new Error('Отменено пользователем');
            }

            json = await request('composer-api.bx/_action/' + otp.action, 'POST', {}, {
                ...deviceInfo,
                ...otp.data,
                extraOtp: otpCode
            });
        }

        if (json.data && json.data.authToken) {
            saveAuthToken(json.data.authToken);
        }
    }

    console.log('Logged in successfully');
}

function saveAuthToken(authToken) {
    Keychain.set('ozonWidget_authToken', JSON.stringify(authToken));
}

async function refreshAuthToken(authToken) {
    let json = await request('composer-api.bx/_action/initAuthRefresh', 'POST', {}, {
        "refreshToken": authToken.refreshToken
    });

    if (!json.authToken) {
        throw new Error('Не удалось обновить токен');
    }

    saveAuthToken(json.authToken);

    return {
        'Authorization': json.authToken.tokenType + ' ' + json.authToken.accessToken
    }
}

async function getAuthHeader() {
    let authToken = JSON.parse(Keychain.get('ozonWidget_authToken'));

    let authHeader = {
        'Authorization': authToken.tokenType + ' ' + authToken.accessToken
    }

    // check token validity
    try {
        await request('composer-api.bx/_action/getUserV2', 'POST', authHeader, {"profile": true});
    } catch (e) {
        if (debug) {
            console.error(e);
        }

        authHeader = await refreshAuthToken(authToken);
    }

    return authHeader;
}

// show emoji
function showEmoji(widget) {
    let emoji = widget.addText('📦✈️🚚📬');
    emoji.font = Font.boldSystemFont(50);
    emoji.centerAlignText()
    emoji.textColor = new Color("#000000");
}

async function createWidget(authHeader) {
    let widget = new ListWidget();
    widget.backgroundColor = new Color("#FFFFFF");

    let jsonData = await request('composer-api.bx/page/json/v2?url=/my/orderlist/barcode/', 'GET', authHeader);
    let barcodeStateId = Object.keys(jsonData.widgetStates).find(key => key.startsWith('barcode'));

    if (!barcodeStateId) {
        showEmoji(widget);

        return widget;
    }

    let barcodeData = JSON.parse(jsonData.widgetStates[barcodeStateId]);

    if (!barcodeData.shipments || barcodeData.shipments.length === 0 || (!barcodeData.shipments[0].hasOwnProperty('code') && !barcodeData.shipments[0].hasOwnProperty('hint'))) {
        showEmoji(widget);

        return widget;
    }

    // barcode
    let code = barcodeData.shipments[0].code;
    let reqBarcodeImage = await new Request('https://api.ozon.ru/my-account-api-gateway.bx/codes/v1/generate?code=' + code + '&height=198&type=bar&width=670');
    let barcodeImage = await reqBarcodeImage.loadImage();
    let barcodeImageElement = widget.addImage(barcodeImage);
    barcodeImageElement.centerAlignImage();

    // hint
    widget.addSpacer(5);
    let hint = widget.addText(barcodeData.shipments[0].hint);
    hint.font = Font.boldSystemFont(25);
    hint.centerAlignText()
    hint.textColor = new Color("#000000");

    // Return the created widget
    return widget;
}

async function setupWidget() {
    if (!Keychain.contains('ozonWidget_authToken')) {
        try {
            await setupAssistant();
        } catch (e) {
            if (debug) {
                console.error(e);
            }

            return;
        }
    }

    let authHeader = await getAuthHeader();
    let widget = await createWidget(authHeader);

    // Check where the script is running
    if (config.runsInWidget) {
        // Runs inside a widget so add it to the homescreen widget
        // Refresh the widget after 8 hours
        widget.refreshAfterDate = new Date(Date.now() + 8 * 60 * 60 * 1000);

        Script.setWidget(widget);
    } else if (config.runsInApp && args.widgetParameter && Object.keys(args.widgetParameter).length > 0) {
        // Open Ozon app and show the expanded barcode
        Safari.open('ozon://my/barcodeExpanded/');
    } else {
        // Show the medium widget inside the app
        widget.presentMedium();
    }

    Script.complete();
}

await setupWidget();
