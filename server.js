const express = require('express');
const { Client } = require('@notionhq/client');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const moment = require('moment');
const fs = require('fs');
const cron = require('node-cron');
const app = express();
const PORT = 3000;
const fetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');
const dotenv = require('dotenv');
dotenv.config();

// Прокси-сервер
const proxyUrl = process.env.PROXY_URL;
const agent = new SocksProxyAgent(proxyUrl);

// Кастомная функция fetch
const customFetch = (url, options) => {
    return fetch(url, {
      ...options,
      agent: new SocksProxyAgent(proxyUrl),
      timeout: 10000  // Увеличиваем таймаут до 10 секунд
    });
  };
const THRESHOLD_SEC = 20;
// Используемый middleware
app.use(express.json());

axiosRetry(axios, {
  retries: 5,
  retryDelay: (retryCount) => {
    console.log(`Повторная попытка: ${retryCount}`);
    return retryCount * 10000;  // Интервал между повторными попытками
  },
  retryCondition: (error) => {
    return error.code === 'ECONNRESET' || error.response?.status >= 500;
  }
});

const PATHS = {
    webhookData: './webhookData.json',
    idPairs: './idPairs.json',
    companyPairs: './companyPairs.json',
    cacheId: './cacheId.json',
    pachcaUsers: './PachcaUsers.json',
    channelInfo: './channelInfo.json',
    scheduledTasks: './scheduledTasks.json',
    customIdPairs: './customIdPairs.json',
    ID_URL_PATH: './idurl.json',
    LAST_ID_PATH: './lastTs.txt',
    IDCOM_PATH: './idcom.json'
};

// Инициализация Notion API
const notion = new Client({
    auth: process.env.NOTION_TOKEN,
    fetch: (url, options) => customFetch(url, {
      ...options,
      timeout: 5000,  // Устанавливаем таймаут на 5 секунд
    })
  });

  app.post('/demo', async (req, res) => {
    const { type, event, id: messageId, parent_message_id, content } = req.body;
    console.log(`Получен запрос на /demo с типом: ${type}, событием: ${event}, parent_message_id: ${parent_message_id}, содержанием: ${content}`);

    const customIdPairs = loadJsonFile('./customIdPairs.json');
    const idPairs = loadJsonFile('./idPairs.json');

    if (type === 'message' && event === 'new') {
        if (parent_message_id && customIdPairs[parent_message_id]) {
            const { originalMessageId, type: actionType } = customIdPairs[parent_message_id];
            const pageId = idPairs[originalMessageId]; // Получаем pageId по originalMessageId

            if (!pageId) {
                console.error(`Ошибка: pageId не найден для originalMessageId: ${originalMessageId}`);
                return res.status(400).send('pageId не найден для originalMessageId');
            }

            console.log(`Найден pageId: ${pageId} для originalMessageId: ${originalMessageId} и действия: ${actionType}`);

            if (actionType === 'date') {
                const parsedDate = parseDate(content.trim());
                if (parsedDate) {
                    console.log(`Начало обновления даты для pageId: ${pageId} с датой: ${parsedDate}`);
                    await updateNotionDemoDateByPageId(pageId, parsedDate);
                    const responseMessage = await sendReaction(messageId);
                    if (responseMessage.status === 200) {
                        console.log('Реакция 👍 успешно отправлена');
                    }
                    res.status(200).send('Дата обновлена в Notion');
                } else {
                    console.error('Ошибка: Неверный формат даты');
                    res.status(400).send('Неверный формат даты');
                }
            } else if (actionType === 'context') {
                console.log(`Начало добавления контекста для pageId: ${pageId}`);
                await addContextToNotionPage(pageId, content);
                const responseMessage = await sendReaction(messageId);
                if (responseMessage.status === 200) {
                    console.log('Реакция 👍 успешно отправлена');
                }
                res.status(200).send('Контекст добавлен в Notion');
            } else {
                console.error('Ошибка: Неизвестный тип действия');
                res.status(400).send('Неизвестный тип действия');
            }
        } else {
            console.error('Ошибка: Идентификатор родительского сообщения не распознан');
            res.status(400).send('Идентификатор родительского сообщения не распознан');
        }
    } else {
        console.error('Ошибка: Неподдерживаемый тип сообщения или события');
        res.status(400).send('Неподдерживаемый тип сообщения или события');
    }
});

app.post('/sale', async (req, res) => {
  const data = req.body;
  // --- ОБРАБОТКА message/new/thread WEBHOOK ---
  if (
    data.type === 'message' &&
    data.event === 'new' &&
    data.entity_type === 'thread' &&
    data.thread?.message_id
  ) {
    // Заголовки для Pachca API
    const headers = {
      'Authorization': `Bearer ${process.env.PACHCA_TOKEN1}`,
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'YourApp/1.0'
    };
    try {
      // 1. Получаем сообщение, к которому создан тред
      const resp = await axios.get(
        `https://api.pachca.com/api/shared/v1/messages/${data.thread.message_id}`,
        { headers }
      );
      const content = resp.data.data.content;
      // 2. Извлекаем ID компании
      const companyId = extractCompanyId(content);
      if (companyId) {
        // 3. Загружаем и обновляем кеш
        const idcom = loadIdCom();
        idcom[companyId] = data.content;
        saveIdCom(idcom);
        console.log(`Кешировано: [${companyId}] => ${data.content}`);
      } else {
        console.log('ID Компании не найдено, кеш не обновлен');
      }
      return res.sendStatus(200);
    } catch (err) {
      console.error('Ошибка при обработке message/new:', err);
      return res.status(500).send('Ошибка при обработке message');
    }
  }
  // ОБРАБОТКА СЧЕТА
  console.log('Получены данные для счета:', data);

  let lastId = null;
  try {
    lastId = fs.readFileSync(PATHS.LAST_ID_PATH, 'utf8');
  } catch {}
  if (lastId && Number(lastId) === data.id) {
    console.log(`Пропуск повторного запроса для ID=${data.id}`);
    return res.sendStatus(200);
  }
  // Сохраняем текущий ID
  fs.writeFileSync(PATHS.LAST_ID_PATH, String(data.id));

  // Заголовки для Pachca API
  const headers = {
    'Authorization': `Bearer ${process.env.PACHCA_TOKEN1}`,
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'YourApp/1.0'
  };

  // Загрузка URL маппинга
  const mappings = loadIdUrlMappings();
  let threadUrl = mappings[data.id];
  let isNew = !threadUrl;

  // Если нет URL, ищем старое сообщение и создаем тред
  if (isNew) {
    try {
      const foundMsgId = await findMessageWithId(data.id, headers);
      if (foundMsgId) {
        console.log(`Найдено существующее сообщение ${foundMsgId}`);
        const threadResp = await axios.post(
          `https://api.pachca.com/api/shared/v1/messages/${foundMsgId}/thread`,
          {},
          { headers }
        );
        threadUrl = `https://app.pachca.com/chats?thread_id=${threadResp.data.data.id}`;
        isNew = false;
      }
    } catch (err) {
      console.error('Ошибка при поиске в истории чата:', err);
    }
  }

  // Вычисление периода
  const period = {
    startDate: moment().format('YYYY-MM-DD'),
    endDate: calculateEndDate(data.months_count)
  };
  // Загрузка extra content (idcom)
  const idcom = loadIdCom();
  const extraContent = idcom[data.id] ? `\n\`${idcom[data.id]}\`` : '';
  // Формирование контента
  const content = isNew
    ? `⚾ 🏌🏼‍♂️Новый клиент **${data.name}** запросил счет!\nID Компании: ${data.id}\nПочта: ${data.email}\nИНН: ${data.inn}\nТариф: ${data.plan}\nКол-во пользователей: **${data.licenses_total}**\nПериод: **${data.months_count}**\n* Лицензия программы для ЭВМ "Пачка", модуль "${data.plan}" на срок с ${period.startDate} по ${period.endDate})${extraContent}`
    : `🥳 🚀Компания **${data.name}** запросила новый счет!\nID Компании: ${data.id}\nПочта: ${data.email}\nИНН: ${data.inn}\nТариф: ${data.plan}\nКол-во пользователей: **${data.licenses_total}**\nПериод: **${data.months_count}**\n* Лицензия программы для ЭВМ "Пачка", модуль "${data.plan}" на срок с ${period.startDate} по ${period.endDate}\n[Тред](${threadUrl})${extraContent}`;


  try {
    console.log(`Отправка сообщения для ${data.id} (isNew=${isNew})`);
    const sendResp = await axios.post(
      `https://api.pachca.com/api/shared/v1/messages`,
      { message: { entity_type: 'discussion', entity_id: 2342381, content } },
      { headers }
    );
    console.log('Уведомление отправлено:', sendResp.data);

    if (isNew) {
      const messageId = sendResp.data.data.id;
      console.log(`Создание треда для сообщения ${messageId}`);
      const threadResp = await axios.post(
        `https://api.pachca.com/api/shared/v1/messages/${messageId}/thread`,
        {},
        { headers }
      );
      threadUrl = `https://app.pachca.com/chats?thread_id=${threadResp.data.data.id}`;
      console.log(`Создан новый тред ${threadResp.data.data.id}`);
    }

    // Сохранение URL и нового webhook_timestamp
    mappings[data.id] = threadUrl;
    saveIdUrlMappings(mappings);

    return res.sendStatus(200);
  } catch (error) {
    console.error('Ошибка в эндпоинте /sale:', error);
    return res.status(500).send('Ошибка сервера');
  }
});

function calculateEndDate(monthsCount) {
  return moment().add(monthsCount, 'months').format('YYYY-MM-DD');
}

async function getAllPages(databaseId) {
    let allPages = [];
    let hasMore = true;
    let nextCursor = undefined;

    while (hasMore) {
        try {
            const response = await notion.databases.query({
                database_id: databaseId,
                start_cursor: nextCursor,
            });

            allPages = allPages.concat(response.results);

            // Проверяем, нужно ли продолжать запросы
            hasMore = response.has_more;
            nextCursor = response.next_cursor;

        } catch (error) {
            console.error('Error querying Notion API:', error);
            if (error.response) {
                console.error('Response data:', error.response.data);
            }
            throw error;
        }
    }

    return allPages;
}
async function createSaleNotionPage(data, endDate) {
    console.log('Creating Notion page for sale...');
    console.log('Data received:', data);
    console.log('End date:', endDate);

    const databaseId = process.env.DATABASE_ID;
    const title_content = data.name;

    try {
        // Логируем запрос перед отправкой
        console.log('Sending request to Notion API with the following payload:');
        console.log({
            parent: { database_id: databaseId },
            properties: {
                'Name': {
                    title: [{ text: { content: title_content } }]
                },
                'Название этапа 1': {
                    rich_text: [{ text: { content: '——————— Информация о клиенте ———————' } }]
                },
                'Название этапа 2': {
                    rich_text: [{ text: { content: '——————— Активные ———————' } }]
                },
                'Название этапа 3': {
                    rich_text: [{ text: { content: '——————— Ушедшие ———————' } }]
                },
                'Контакты': {
                    rich_text: [{ text: { content: `Номер телефона: , имя контакта: ` } }]
                },
                "Этап": {
                    status: { name: "Запросили счет" }
                },
                "ID": {
                    number: Number(data.id)
                },
                "ИНН": {
                    rich_text: [{ text: { content: `${data.inn}` } }]
                },
                "Почта админа": {
                    rich_text: [{ text: { content: `${data.email}` } }]
                },
                "Тариф": {
                    select: { name: `${data.plan}` }
                },
                "Пользователи": {
                    number: Number(data.licanses_total)
                },
                'Следующая оплата': {
                    date: { start: endDate }
                }
            }
        });

        const response = await notion.pages.create({
            parent: { database_id: databaseId },
            properties: {
                'Name': {
                    title: [{ text: { content: title_content } }]
                },
                'Название этапа 1': {
                    rich_text: [{ text: { content: '——————— Информация о клиенте ———————' } }]
                },
                'Название этапа 2': {
                    rich_text: [{ text: { content: '——————— Активные ———————' } }]
                },
                'Название этапа 3': {
                    rich_text: [{ text: { content: '——————— Ушедшие ———————' } }]
                },
                'Контакты': {
                    rich_text: [{ text: { content: `Номер телефона: , имя контакта: ` } }]
                },
                "Этап": {
                    status: { name: "Запросили счет" }
                },
                "ID": {
                    number: Number(data.id)
                },
                "ИНН": {
                    rich_text: [{ text: { content: `${data.inn}` } }]
                },
                "Почта админа": {
                    rich_text: [{ text: { content: `${data.email}` } }]
                },
                "Тариф": {
                    select: { name: `${data.plan}` }
                },
                "Пользователи": {
                    number: Number(data.licanses_total)
                },
                'Следующая оплата': {
                    date: { start: endDate }
                }
            }
        });

        console.log("Page created with ID:", response.id);
        return response.id;
    } catch (error) {
        console.error("Error creating page in Notion:", error);
        console.log('Response body:', error.body);
        throw error;
    }
}

function calculatePeriod(startDate, monthsCount) {
    const start = moment(startDate);
    const end = start.clone().add(monthsCount, 'months').subtract(1, 'days');
    return {
        startDate: start.format('DD.MM.YYYY'),
        endDate: end.format('DD.MM.YYYY'),
    };
}

async function updateNextPaymentDate(pageId, nextPaymentDate) {
    try {
        await notion.pages.update({
            page_id: pageId,
            properties: {
                'Следующая оплата': {
                    date: {start: nextPaymentDate}
                },
                "Этап": {
                status: {
                    name: "Запросили счет"
                    }
                }
            }
        });

        console.log("Поле 'Следующая оплата' успешно обновлено:");
    } catch (error) {
        console.error("Ошибка при обновлении поля 'Следующая оплата':", error);
    }
}

async function getPaymentInfo(databaseId, targetID, data) {
  console.log(`Запрос данных оплаты для базы данных с ID: ${databaseId} и целевого ID: ${targetID}`);

  try {
    // Вычисляем дату окончания периода
    const endDate = calculateEndDate(data.months_count);
    console.log(`Вычисленная дата окончания периода: ${endDate}`);

    // Получаем все страницы из базы данных
    const allPages = await getAllPages(databaseId);

    // Логируем данные каждой страницы для отладки
    allPages.forEach((page, index) => {
    });

    // Ищем страницу с нужным ID
    const matchingPage = allPages.find(page => {
      const idProperty = page.properties['ID'];
      if (idProperty) {

        let pageIdValue;
        if (idProperty.type === 'number') {
          pageIdValue = idProperty.number;
        } else if (idProperty.type === 'rich_text' && idProperty.rich_text.length > 0) {
          pageIdValue = Number(idProperty.rich_text[0].plain_text);
        } else {
          console.log("ID не может быть преобразован в число:", JSON.stringify(idProperty));
          return false;
        }

        return pageIdValue === Number(targetID);
      } else {
        console.log("ID не найдено на странице:", JSON.stringify(page, null, 2));
        return false;
      }
    });

    let period;

    if (matchingPage) {
      console.log("Совпадение страницы найдено.");

      const pageId = matchingPage.id;
      const titleProperty = matchingPage.properties['Name'] || matchingPage.properties['Название'];
      const title = titleProperty ? titleProperty.title[0]?.text?.content || 'Название отсутствует' : 'Название отсутствует';
      const threadWithAccount = matchingPage.properties['Тред со счетом']?.rich_text[0]?.text?.content || 'Тред не найден';
      const link = createNotionPageLink(pageId);
      let nextPayment = matchingPage.properties['Следующая оплата']?.date?.start || 'Дата оплаты отсутствует';

      if (nextPayment) {
        period = calculatePeriod(nextPayment, data.months_count);
        console.log(`Расчетный период на основе следующей даты оплаты: ${period.startDate} - ${period.endDate}`);
      } else {
        console.log("Следующая дата оплаты не найдена, расчет с текущей даты.");
        period = calculatePeriod(moment().format('YYYY-MM-DD'), data.months_count);
      }

      // Отправляем уведомление с информацией
      const url = `https://api.pachca.com/api/shared/v1/messages/`;
      const headers = {
        'Authorization': `Bearer ${process.env.PACHCA_TOKEN1}`,
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 OPR/107.0.0.0 (Edition Yx GX)'
      };

      const payload = {
        "message": {
          "entity_type": "discussion",
          "entity_id": 2342381,
          "content": `🥳 🚀Компания **${title}** запросила новый счет!\nID Компании: ${data.id}\nПочта: ${data.email}\nИНН: ${data.inn}\nТариф: ${data.plan}\nКол-во пользователей: **${data.licenses_total}**\nПериод: **${data.months_count}**\n* Лицензия программы для ЭВМ "Пачка", модуль "${data.plan}" на срок с ${period.startDate} по ${period.endDate}\n[Тред](${threadWithAccount}) || [Карточка](${link}).`
        }
      };

      console.log("Отправляем payload:", JSON.stringify(payload, null, 2));
      const response = await axios.post(url, payload, { headers: headers });
      console.log("Уведомление успешно отправлено, данные ответа:", response.data);

      await updateNextPaymentDate(pageId, endDate);

    } else {
      console.log('Совпадение страницы не найдено, создаем новую запись.');
      period = calculatePeriod(moment().format('YYYY-MM-DD'), data.months_count);

      const pageId = await createSaleNotionPage(data, endDate);
      const link = createNotionPageLink(pageId);
      const url = `https://api.pachca.com/api/shared/v1/messages/`;
      const headers = {
        'Authorization': `Bearer ${process.env.PACHCA_TOKEN1}`,
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 OPR/107.0.0.0 (Edition Yx GX)'
      };

      const payload = {
        "message": {
          "entity_type": "discussion",
          "entity_id": 2342381,
          "content": `⚾ 🏌🏼‍♂️Новый клиент **${data.name}** запросил счет!\nID Компании: ${data.id}\nПочта: ${data.email}\nИНН: ${data.inn}\nТариф: ${data.plan}\nКол-во пользователей: **${data.licenses_total}**\nПериод: **${data.months_count}**\n* Лицензия программы для ЭВМ "Пачка", модуль "${data.plan}" на срок с ${period.startDate} по ${period.endDate}\n[Карточка](${link}).`
        }
      };

      console.log("Отправляем payload для новой записи:", JSON.stringify(payload, null, 2));
      const response1 = await axios.post(url, payload, { headers: headers });
      console.log("Уведомление для новой записи успешно отправлено, данные ответа:", response1.data);

      const threadId = response1.data.data.id;
      await notion.pages.update({
        page_id: pageId,
        properties: {
          'Тред со счетом': {
            rich_text: [
              { text: { content: `https://app.pachca.com/chats/2342381?thread_message_id=${threadId}`} }
            ]
          }
        }
      });
    }
  } catch (error) {
    console.error('Ошибка:', error);
    if (error.response) {
      console.error('Статус ошибки:', error.response.status);
      console.error('Тело ошибки:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}


app.get('/test', async (req, res) => {
    res.status(200).send('Test ok');
});

/** ========== Блок работы с Notion API ========== **/

app.post('/webhook', async (req, res) => {
    const data = req.body;
    fs.writeFileSync(PATHS.webhookData, JSON.stringify(data, null, 2));
    // Пересылка входящего payload на внешний сервис
    try {
        await axios.post(process.env.WEBHOOK_URL, data);
        res.status(200).send('Webhook received and forwarded');
    } catch (error) {
        console.error('Error forwarding webhook:', error);
        res.status(500).send('Failed to forward webhook');
    }
});

app.post('/analytic', async (req, res) => {
    const data = req.body;

    if (data.message && data.message.content === 'демки') {
        console.log('Запрос на аналитику демо');

        try {
            const { demoToday, scheduledDemos, unscheduledDemos } = await collectDemoData();

            // Формируем список демо на сегодня с пользователями
            const demoTodayList = demoToday
                .map(demo => `${demo.title} - ${demo.user || '@unknown'}`)
                .filter(Boolean);

            // Формируем список запланированных демо с пользователями
            const scheduledDemosList = scheduledDemos
                .map(demo => `${demo.title} - ${moment(demo.date).format('DD.MM')} - ${demo.user || '@unknown'}`)
                .filter(Boolean);

            // Формируем список незапланированных демо с пользователями
            const unscheduledDemosList = unscheduledDemos
                .map(demo => `${demo.title} - ${demo.user || '@unknown'}`)
                .filter(Boolean);

            // Формируем итоговый отчет
            const report = `
🟢Демо сегодня:
${demoTodayList.length ? '- ' + demoTodayList.join('\n- ') : 'Нет демо на сегодня'}

🟡Запланированные:
${scheduledDemosList.length ? '- ' + scheduledDemosList.join('\n- ') : 'Нет запланированных демо'}

🔴Незапланированные:
${unscheduledDemosList.length ? '- ' + unscheduledDemosList.join('\n- ') : 'Нет незапланированных демо'}
            `;

            console.log('Отправляем собранные данные о демо:', report);
            await sendDemoReport(report);
            res.status(200).send('Отчет о демо отправлен.');
        } catch (error) {
            console.error('Ошибка при сборе данных для демо:', error);
            res.status(500).send('Ошибка при сборе данных для демо.');
        }
    } else {
        res.status(400).send('Неверный контент');
    }
});


// Функция для сбора данных по демо с учетом реакции пользователя
async function collectDemoData() {
    const idPairs = loadJsonFile(PATHS.idPairs);
    let demoToday = [];
    let scheduledDemos = [];
    let unscheduledDemos = [];
    const today = moment().startOf('day');

    for (const [messageId, pageId] of Object.entries(idPairs)) {
        try {
            const page = await notion.pages.retrieve({ page_id: pageId });
            const title = page.properties['Name']?.title[0]?.text?.content || 'Без названия';

            // Проверяем, является ли это заявкой на таблицу или на демо
            const isTableRequest = title.includes(', На что пришли: Заявка на сравнительную таблицу попап');
            const isDemoRequest =
                title.includes(', На что пришли: Созвон по мессенджеру Главная') ||
                title.includes(', Таблица + Демо');

            if (isTableRequest) continue;  // Пропускаем заявки на таблицу
            if (!isDemoRequest) continue;  // Пропускаем не относящиеся к демо заявки

            // Проверка поля "Этап"
            const stageStatus = page.properties['Этап']?.status?.name;
            if (stageStatus !== 'Проводим демо') continue;

            const companyName = cleanTitle(title);
            const demoDate = page.properties['Дата демо']?.date?.start;

            // Получаем пользователя с реакцией
            const userReaction = await getUserByReaction(messageId);

            const logEntry = {
                pageId,
                messageId,
                title: companyName,
                date: demoDate || 'Дата отсутствует',
                user: userReaction || 'Пользователь не найден',
                stageStatus,
            };

            if (demoDate) {
                const demoMoment = moment(demoDate);
                if (demoMoment.isSame(today, 'day')) {
                    demoToday.push(logEntry);
                    console.log(`Добавлено в demoToday:`, logEntry);
                } else if (demoMoment.isAfter(today)) {
                    scheduledDemos.push(logEntry);
                    console.log(`Добавлено в scheduledDemos:`, logEntry);
                }
            } else {
                unscheduledDemos.push(logEntry);
                console.log(`Добавлено в unscheduledDemos:`, logEntry);
            }
        } catch (error) {
            console.error(`Ошибка обработки страницы с ID ${pageId}:`, error);
        }
    }

    return { demoToday, scheduledDemos, unscheduledDemos };
}

app.post('/data', async (req, res) => {
    const { type, code, event, id, user_id } = req.body;
    const messageId = type === 'message' ? id : type === 'reaction' ? req.body.message_id : null;

    if (req.body.user_id === 371852 && type === 'message') {
        try {
            const url = `https://api.pachca.com/api/shared/v1/messages/${id}/thread`;
            const headers = {
                'Authorization': `Bearer ${process.env.PACHCA_TOKEN2}`,
                'Content-Type': 'application/json; charset=utf-8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 OPR/107.0.0.0 (Edition Yx GX)'
            };
            const response = await axios.post(url, {}, { headers: headers });
            const thread_id = response.data.data.id;
            const rawData = fs.readFileSync(PATHS.webhookData, 'utf8');
            const data = JSON.parse(rawData);
            const pageId = await createNotionPage(data);
            await saveCompanyInfo(pageId, data.payload.data.Company);
            const notionPageLink = createNotionPageLink(pageId);
            await sendLinkMessage(thread_id, notionPageLink, messageId);
            await saveIdPair(messageId, pageId);
            return res.json({ message: 'Page created', pageId: pageId });
        } catch (error) {
            return res.status(500).send('Failed to create page');
        }
    } else if (type === 'reaction' && code === '➕') {
        if (event === 'new') {
            try {
                const cachedId = readCacheId();
                console.log(`Cached ID: ${cachedId}`);
                console.log(`Current Message ID: ${messageId}`);
                if (cachedId) {
                    const cachedPageId = getPageIdById(cachedId);
                    console.log(cachedPageId);
                    const pageId = getPageIdById(messageId);
                    console.log(messageId);
                    if (!pageId) {
                        console.error('No page ID found for the given message ID');
                        return res.status(404).send('No page found');
                    }
                    await updateNotionPage4(pageId);
                    await deleteNotionPage(cachedPageId);

                    const rawIdPairs = fs.readFileSync(PATHS.idPairs, 'utf8');
                    const idPairs = JSON.parse(rawIdPairs);
                    delete idPairs[cachedId];
                    fs.writeFileSync(PATHS.idPairs, JSON.stringify(idPairs, null, 2));
                    console.log('Page and corresponding ID pair deleted successfully');
                    res.send('Cache processed and cleared');
                    clearCacheId();
                } else {
                    saveCacheId(messageId);
                    return res.send('Message ID cached');
                }
            } catch (error) {
                return res.status(500).send('Error processing reaction');
            }
        } else if (event === 'delete') {
            clearCacheId();
            return res.send('Cache cleared on delete');
        }
    } else if (type === 'reaction' && (code === '✅' || code === '❌' || code === '✏️')) {
        const pageId = getPageIdById(messageId);
        if (!pageId) {
            console.error('Page ID not found for given message ID');
            return res.status(404).send('Page ID not found');
        }
        if (event === 'delete' && (code === '✅' || code === '✏️')) {
            await updateNotionPage3(pageId);

            return res.send('Page reset');
        }
        switch (code) {
            case '✅':
                await updateNotionPage(pageId, user_id);
                const delay = 15 * 60 * 1000; // 1 минута в миллисекундах

                console.log(`Планируем выполнение задачи через ${delay / 1000} секунд`);

                const scheduledMessageId = messageId;
                const scheduledUserId = user_id;

                setTimeout(() => {
                    console.log(`Запуск задачи для messageId: ${scheduledMessageId}, user_id: ${scheduledUserId} в ${new Date().toISOString()}`);
                     handleReactionTask(scheduledMessageId, scheduledUserId);
                }, delay);

                console.log(`Задача успешно запланирована с помощью setTimeout`);
                res.send('Page updated');
                break;
            case '❌':
                await deleteNotionPage(pageId);
                try {
                    const rawIdPairs = fs.readFileSync(PATHS.idPairs, 'utf8');
                    const idPairs = JSON.parse(rawIdPairs);
                    delete idPairs[messageId];
                    fs.writeFileSync(PATHS.idPairs, JSON.stringify(idPairs, null, 2));
                    res.send('Page and corresponding ID pair deleted');
                } catch (error) {
                    console.error('Failed to delete ID pair:', error);
                    return res.status(500).send('Failed to delete ID pair');
                }
                break;
            case '✏️':
                await updateNotionPage2(pageId, user_id);
                res.send('Page updated with new name');
                break;
            default:
                res.status(400).send('Invalid reaction code');
                break;
        }
    } else {
        res.status(400).send('Invalid conditions for action');
    }
});

// Функция для создания страницы в Notion
async function createNotionPage(data) {
    const databaseId = process.env.DATABASE_ID;
    const title_content = `${data.payload.data.Company}, На что пришли: ${data.payload.name}`;
    try {
        const response = await notion.pages.create({
            parent: { database_id: databaseId },
            properties: {
                'Name': {
                    title: [
                        { text: { content: title_content } }
                    ]
                },
                'Название этапа 1': {
                    rich_text: [
                        { text: { content: '——————— Информация о клиенте ———————' } }
                    ]
                },
                'Название этапа 2': {
                    rich_text: [
                        { text: { content: '——————— Активные ———————' } }
                    ]
                },
                'Название этапа 3': {
                    rich_text: [
                        { text: { content: '——————— Ушедшие ———————' } }
                    ]
                },
                'Контакты': {
                    rich_text: [
                        { text: { content: `Номер телефона: ${data.payload.data.Phone}, имя контакта ${data.payload.data.Name}` } }
                    ]
                },
                'Дата заявки': {
                    date: { start: data.payload.submittedAt }
                }
            }
        });

        console.log("Page created with ID:", response.id);
        return response.id;
    } catch (error) {
        console.error("Error creating page in Notion:", error);
        throw error;
    }
}

// Функция для редактирования страницы в Notion
async function updateNotionPage(pageId, user_id) {
    const userName = readPachcaUsers(user_id);
    return notion.pages.update({
        page_id: pageId,
        properties: {
            "Этап": {
                status: {
                    name: "Проводим демо"
                }
            },
            'Откуда о нас узнали': {
                rich_text: [
                    { text: { content: `Реакцию оставил(а): ${userName}` } }
                ]
            }
        }
    });
}

async function updateNotionPage2(pageId, user_id) {
    const userName = readPachcaUsers(user_id);
    return notion.pages.update({
        page_id: pageId,
        properties: {
            "Этап": {
                status: {
                    name: "Отправили таблицу"
                }
            },
            'Откуда о нас узнали': {
                rich_text: [
                    { text: { content: `Реакцию оставил(а): ${userName}` } }
                ]
            }
        }
    });
}

async function updateNotionPage3(pageId) {
    return notion.pages.update({
        page_id: pageId,
        properties: {
            "Этап": {
                status: {
                    name: "Заявка"
                }
            },
            'Откуда о нас узнали': {
                rich_text: [
                    { text: { content: `` } }
                ]
            }
        }
    });
}

async function updateNotionPage4(pageId) {
    const notionPageLink = createNotionPageLink(pageId);
    const companyName = companyPairs[pageId];
    const companyPairs = loadCompanyPairs(); // Загрузите пары компани
    const url = `https://api.pachca.com/api/shared/v1/messages`;
    const body = {
        "message": {
            "entity_type": "discussion",
            "entity_id": 4624312,
            "content": `Карточки компании ${companyName} были объединены: [link](${notionPageLink})`
        }
    };
    const headers = {
        'Authorization': `Bearer ${process.env.PACHCA_TOKEN1}`,
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 OPR/107.0.0.0 (Edition Yx GX)'
    };
    await axios.post(url, body, { headers: headers });
    return notion.pages.update({
        page_id: pageId,
        properties: {
            'Name': {
                title: [
                    { text: { content: `${companyName}, Таблица + Демо ` } }
                ]
            },
            "Этап": {
                status: {
                    name: "Заявка"
                }
            },
            'Откуда о нас узнали': {
                rich_text: [
                    { text: { content: `` } }
                ]
            }
        }
    });
}

async function deleteNotionPage(pageId) {
    try {
        await notion.pages.update({
            page_id: pageId,
            archived: true
        });
        console.log("Page deleted successfully");
    } catch (error) {
        console.error("Error deleting page in Notion:", error);
        throw error;
    }
}

// Функция для сохранения информации о компании
function saveCompanyInfo(id, companyName) {
  let companyPairs = loadCompanyPairs(); // Загружаем текущие пары из файла
  companyPairs[id] = companyName;
  try {
    fs.writeFileSync(PATHS.companyPairs, JSON.stringify(companyPairs, null, 2));
    console.log("Company info saved successfully");
  } catch (error) {
    console.error("Error saving company info:", error);
  }
}

function loadCompanyPairs() {
    try {
        if (fs.existsSync(PATHS.companyPairs)) {
            const data = fs.readFileSync(PATHS.companyPairs, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("Failed to load company pairs:", error);
    }
    return {};
}

function saveCacheId(message_id) {
    try {
        fs.writeFileSync(PATHS.cacheId, JSON.stringify({ message_id }));
        console.log("Message ID saved to cache");
    } catch (error) {
        console.error("Error saving to cacheId.json:", error);
        throw error;
    }
}

function readCacheId() {
    try {
        if (fs.existsSync(PATHS.cacheId)) {
            const data = fs.readFileSync(PATHS.cacheId, 'utf8');
            return JSON.parse(data).message_id;
        }
    } catch (error) {
        console.error("Failed to read cacheId.json:", error);
    }
    return null;
}

function clearCacheId() {
    try {
        fs.writeFileSync(PATHS.cacheId, JSON.stringify({}));
        console.log("Cache cleared");
    } catch (error) {
        console.error("Error clearing cacheId.json:", error);
        throw error;
    }
}

// Функция для сохранения пары messageId и pageId
function saveIdPair(id, pageId) {
  let idPairs = loadIdPairs(); // Загружаем текущие пары из файла
  idPairs[id] = pageId;
  try {
    fs.writeFileSync(PATHS.idPairs, JSON.stringify(idPairs, null, 2));
    console.log("ID pairs saved successfully");
  } catch (error) {
    console.error("Error saving ID pairs:", error);
  }
}

function getPageIdById(id) {
    const pairs = loadIdPairs();
    console.log(`Looking up Page ID for Message ID: ${id}, found: ${pairs[id]}`);
    return pairs[id];
}

function loadIdPairs() {
    try {
        if (fs.existsSync(PATHS.idPairs)) {
            const data = fs.readFileSync(PATHS.idPairs, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("Failed to load or parse ID pairs:", error);
    }
    return {};
}

function readPachcaUsers(user_id) {
    try {
        const data = fs.readFileSync(PATHS.pachcaUsers, 'utf8');
        const users = JSON.parse(data);
        return users[user_id] || "Пользователь не найден";
    } catch (error) {
        console.error("Failed to read or parse PachcaUsers.json:", error);
        return "Ошибка чтения файла";
    }
}

async function sendLinkMessage(thread_id, notionPageLink, messageId) {
    try {
        // Отправляем кнопку с ссылкой
        await sendTextLink(thread_id, notionPageLink);
        console.log('Сообщение с кнопкой отправлено успешно');

        // Отправляем сообщение "Добавить дату демо" и сохраняем id
        const addDateResponse = await sendTextMessage(thread_id, "Добавить дату демо");
        const parentMessageIdForDate = addDateResponse.data.id;
        console.log(`Получен parentMessageId для "Добавить дату демо": ${parentMessageIdForDate}`);

        // Проверка перед сохранением
        if (!messageId) {
            console.error('Ошибка: originalMessageId (messageId) не определён перед сохранением "Добавить дату демо"');
        }
        saveCustomIdPair(messageId, parentMessageIdForDate, 'date');

        // Отправляем сообщение "Добавить контекст" и сохраняем id
        const addContextResponse = await sendTextMessage(thread_id, "Добавить контекст");
        const parentMessageIdForContext = addContextResponse.data.id;
        console.log(`Получен parentMessageId для "Добавить контекст": ${parentMessageIdForContext}`);

        // Проверка перед сохранением
        if (!messageId) {
            console.error('Ошибка: originalMessageId (messageId) не определён перед сохранением "Добавить контекст"');
        }
        saveCustomIdPair(messageId, parentMessageIdForContext, 'context');

    } catch (error) {
        console.error('Ошибка при отправке сообщений:', error);
    }
}

async function sendTextMessage(thread_id, content) {
    const url = 'https://api.pachca.com/api/shared/v1/messages';
    const body = {
        "message": {
            "entity_type": "thread",
            "entity_id": thread_id,
            "content": content
        }
    };
    const headers = {
        'Authorization': `Bearer ${process.env.PACHCA_TOKEN3}`, // Ваш API токен
        'Content-Type': 'application/json; charset=utf-8',
    };

    try {
        const response = await axios.post(url, body, { headers });
        console.log(`Сообщение "${content}" отправлено успешно, id: ${response.data.data.id}`);
        return response.data; // Возвращаем данные ответа, чтобы использовать id
    } catch (error) {
        console.error(`Ошибка при отправке сообщения "${content}":`, error);
        throw error;
    }
}

async function sendTextLink(thread_id, content) {
    const url = 'https://api.pachca.com/api/shared/v1/messages';
    const body = {
        "message": {
            "entity_type": "thread",
            "entity_id": thread_id,
            "content": `[Link](${content})`
        }
    };
    const headers = {
        'Authorization': `Bearer ${process.env.PACHCA_TOKEN3}`, // Ваш API токен
        'Content-Type': 'application/json; charset=utf-8',
    };

    try {
        const response = await axios.post(url, body, { headers });
        console.log(`Сообщение "${content}" отправлено успешно, id: ${response.data.data.id}`);
        return response.data; // Возвращаем данные ответа, чтобы использовать id
    } catch (error) {
        console.error(`Ошибка при отправке сообщения "${content}":`, error);
        throw error;
    }
}
function saveCustomIdPair(messageId, parentMessageId, type) {
    if (!parentMessageId) {
        console.error(`Ошибка: parentMessageId не может быть undefined. originalMessageId: ${messageId}, type: ${type}`);
        return;
    }

    if (!messageId) {
        console.error(`Ошибка: originalMessageId не может быть undefined. parentMessageId: ${parentMessageId}, type: ${type}`);
        return;
    }

    console.log(`Сохраняем пару: parent_message_id: ${parentMessageId}, originalMessageId: ${messageId}, type: ${type}`);

    let customIdPairs = loadJsonFile('./customIdPairs.json');

    // Если файл пуст, создаем новый объект
    if (!customIdPairs || Object.keys(customIdPairs).length === 0) {
        console.log('Файл ./customIdPairs.json пуст или отсутствует. Создаем новый объект.');
        customIdPairs = {};
    }

    // Сохраняем новую пару
    customIdPairs[parentMessageId] = { originalMessageId: messageId, type };

    fs.writeFileSync('./customIdPairs.json', JSON.stringify(customIdPairs, null, 2));
    console.log(`Пара успешно сохранена: ${parentMessageId} -> { originalMessageId: ${messageId}, type: ${type} }`);

    // Очищаем кеш, ограничивая количество объектов до 100
    clearCacheCustomIdPairs(customIdPairs);
}

// Функция для очистки кеша customIdPairs, оставляя только последние 500 объектов
function clearCacheCustomIdPairs(customIdPairs) {
    const entries = Object.entries(customIdPairs);

    // Проверяем, превышает ли количество объектов 500
    if (entries.length > 500) {
        console.log(`Чистим кеш customIdPairs. Текущее количество объектов: ${entries.length}`);

        // Оставляем только последние 500 объектов
        const limitedEntries = entries.slice(-500);

        // Преобразуем обратно в объект и сохраняем в файл
        const limitedCustomIdPairs = Object.fromEntries(limitedEntries);

        fs.writeFileSync(PATHS.customIdPairs, JSON.stringify(limitedCustomIdPairs, null, 2));
        console.log('Кеш очищен. Оставлено 500 последних объектов.');
    }
}

async function updateNotionDemoDateByPageId(pageId, newDate) {
    console.log(`Начало обновления даты для страницы в Notion с pageId: ${pageId} и новой датой: ${newDate}`);

    try {
        await notion.pages.update({
            page_id: pageId,
            properties: {
                'Дата демо': {
                    date: {
                        start: newDate
                    }
                }
            }
        });
        console.log(`Дата успешно обновлена для страницы с pageId: ${pageId} на дату: ${newDate}`);
    } catch (error) {
        console.error(`Ошибка при обновлении даты для страницы с pageId: ${pageId}`, error);
        throw error;
    }
}

async function addContextToNotionPage(pageId, content) {
    console.log(`Начало добавления контекста для страницы в Notion с pageId: ${pageId}. Контент: ${content}`);

    try {
        const response = await notion.blocks.children.append({
            block_id: pageId,
            children: [
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [
                            {
                                type: 'text',
                                text: {
                                    content: content
                                }
                            }
                        ]
                    }
                }
            ]
        });

        console.log(`Контекст успешно добавлен в страницу с pageId: ${pageId}`);
    } catch (error) {
        console.error(`Ошибка при добавлении контекста в тело страницы с pageId: ${pageId}`, error);
    }
}

function parseDate(dateString) {
    console.log(`Начало парсинга даты из строки: ${dateString}`);

    const formats = ['DD.MM.YYYY', 'DD.MM.YY', 'DD.MM'];
    let parsedDate = null;

    for (const format of formats) {
        const date = moment(dateString, format, true);
        if (date.isValid()) {
            parsedDate = date.format('YYYY-MM-DD');
            console.log(`Дата успешно распознана в формате: ${format}. Парсинг даты: ${parsedDate}`);
            break;
        }
    }

    if (!parsedDate) {
        console.error(`Ошибка: Не удалось распознать дату из строки: ${dateString}`);
    }

    return parsedDate;
}
async function handleReactionTask(messageId, userId) {
    console.log(`Начало выполнения задания cron для messageId: ${messageId}, userId: ${userId}`);

    // Загрузка entityMap.json
    const entityMap = loadJsonFile('./entityMap.json');
    const username = Object.keys(entityMap).find(key => entityMap[key] === userId);

    if (!username) {
        console.error(`Пользователь с userId ${userId} не найден в entityMap.json`);
        return;
    }

    try {
        // Запрос для получения thread_id и chat_id
        const urlThread = `https://api.pachca.com/api/shared/v1/messages/${messageId}/thread`;
        const headers = {
            'Authorization': `Bearer ${process.env.PACHCA_TOKEN3}`,
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': 'Mozilla/5.0'
        };
        const responseThread = await axios.post(urlThread, {}, { headers });
        const { data } = responseThread.data;
        const chat_id = data.chat_id;
        const thread_id = data.id;

        console.log(`Получены данные: chat_id=${chat_id}, thread_id=${thread_id}`);

        // Запрос для получения списка сообщений по chat_id
        const urlMessages = `https://api.pachca.com/api/shared/v1/messages?chat_id=${chat_id}`;
        const responseMessages = await axios.get(urlMessages, { headers });
        const messages = responseMessages.data.data;

        // Загрузка customIdPairs.json
        const customIdPairs = loadJsonFile('./customIdPairs.json');

        // Проверяем сообщения и ищем совпадение parent_message_id с originalMessageId
        const hasMatchingMessage = messages.some(message => {
            const parentId = message.parent_message_id;
            return customIdPairs[parentId] && customIdPairs[parentId].originalMessageId === messageId;
        });

        if (!hasMatchingMessage) {
            console.log(`Соответствие не найдено. Отправляем сообщение с username ${username}`);

            // Отправляем сообщение в тред
            const urlSendMessage = 'https://api.pachca.com/api/shared/v1/messages';
            const body = {
                "message": {
                    "entity_type": "thread",
                    "entity_id": thread_id,
                    "content": username
                }
            };
            await axios.post(urlSendMessage, body, { headers });

            console.log('Сообщение с username отправлено успешно');
        } else {
            console.log('Соответствие найдено. Действие не требуется');
        }
    } catch (error) {
        console.error('Ошибка при выполнении задания cron:', error);
    }
}


function formatNotionPageId(pageId) {
    return pageId.replace(/-/g, '');
}

function createNotionPageLink(pageId) {
    const formattedPageId = formatNotionPageId(pageId);
    const workspaceName = process.env.WORKSPACE;
    return `https://www.notion.so/${workspaceName}/${formattedPageId}`;
}

// Функция для загрузки entityMap из файла JSON
function loadEntityMap() {
    try {
        const data = fs.readFileSync('./entityMap.json', 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading entity map:', error);
        return {};
    }
}

cron.schedule(
    '0 9 * * *',
    async () => {
        console.log('Running daily demo check...');

        try {
            const { demoToday, scheduledDemos, unscheduledDemos } = await collectDemoData();

            const demoTodayList = demoToday
                .map(demo => `${demo.title} - ${demo.user || '@unknown'}`)
                .filter(Boolean);

            const scheduledDemosList = scheduledDemos
                .map(demo => `${demo.title} - ${moment(demo.date).format('DD.MM')} - ${demo.user || '@unknown'}`)
                .filter(Boolean);

            const unscheduledDemosList = unscheduledDemos
                .map(demo => `${demo.title} - ${demo.user || '@unknown'}`)
                .filter(Boolean);

            const report = `
🟢Демо сегодня:
${demoTodayList.length ? '- ' + demoTodayList.join('\n- ') : 'Нет демо на сегодня'}

🟡Запланированные:
${scheduledDemosList.length ? '- ' + scheduledDemosList.join('\n- ') : 'Нет запланированных демо'}

🔴Незапланированные:
${unscheduledDemosList.length ? '- ' + unscheduledDemosList.join('\n- ') : 'Нет незапланированных демо'}
`;

            console.log('Отправляем собранные данные о демо:', report);
            await sendDemoReport(report);
        } catch (error) {
            console.error('Error during daily demo check:', error);
        }
    },
    {
        scheduled: true,
        timezone: 'Europe/Moscow',
    }
);


// Функция для очистки названия компании
function cleanTitle(title) {
    return title.split(', На что пришли:')[0].trim();
}

// Получение пользователя по реакции на сообщение
async function getUserByReaction(messageId) {
    const entityMap = loadEntityMap(); // Загрузка entityMap.json
    const url = `https://api.pachca.com/api/shared/v1/messages/${messageId}/reactions`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${process.env.PACHCA_TOKEN3}`, // Замените на ваш API токен
                'Content-Type': 'application/json'
            }
        });

        // Ищем реакцию с кодом "✅"
        const reaction = response.data.data.find(r => r.code === '✅');
        if (reaction) {
            const userId = reaction.user_id;
            // Находим имя пользователя по его user_id в entityMap
            const userName = Object.keys(entityMap).find(key => entityMap[key] === userId);
            return userName || 'unknown'; // Если пользователь не найден, вернуть 'unknown'
        }

        return 'unknown'; // Если реакции "✅" нет, возвращаем 'unknown'
    } catch (error) {
        console.error('Ошибка при запросе к API Pachca:', error);
        return 'unknown'; // В случае ошибки возвращаем 'unknown'
    }
}

// Функция для отправки реакции 👍 на сообщение
async function sendReaction(messageId) {
    const url = `https://api.pachca.com/api/shared/v1/messages/${messageId}/reactions`;
    const headers = {
        'Authorization': `Bearer ${process.env.PACHCA_TOKEN3}`,
        'Content-Type': 'application/json; charset=utf-8',
    };
    const body = {
        "code": "👍"
    };

    try {
        const response = await axios.post(url, body, { headers });
        console.log(`Реакция 👍 отправлена на сообщение с ID: ${messageId}`);
        return response;
    } catch (error) {
        console.error(`Ошибка при отправке реакции на сообщение с ID: ${messageId}`, error);
        throw error;
    }
}

// Отправка ежедневного отчета
async function sendDemoReport(content) {
    const headers = {
      'Authorization': `Bearer ${process.env.PACHCA_TOKEN3}`, // Замените на ваш действительный токен
      'Content-Type': 'application/json',
    };

    const url = 'https://api.pachca.com/api/shared/v1/messages/';
    const payload = {
      message: {
        entity_type: 'discussion',
        entity_id: 4624312, // Замените на ваш действительный ID обсуждения
        content: content,
      },
    };

    try {
      const response = await axios.post(url, payload, { headers });
      console.log('Demo report sent successfully:', response.data);
    } catch (error) {
      console.error('Error sending demo report:', error);
      throw error;
    }
}

// Функция для очистки кэша, оставляя только последние 500 объектов
function clearCacheIfTooManyObjects() {
    const companyPairs = loadJsonFile(PATHS.companyPairs);
    const idPairs = loadJsonFile(PATHS.idPairs);

    const companyPairsCount = Object.keys(companyPairs).length;
    const idPairsCount = Object.keys(idPairs).length;

    // Если количество объектов больше 500, оставляем только последние 500
    if (companyPairsCount > 500) {
        const limitedCompanyPairs = limitToLastEntries(companyPairs, 500);
        fs.writeFileSync(PATHS.companyPairs, JSON.stringify(limitedCompanyPairs, null, 2));
        console.log(`companyPairs очищен до последних 500 объектов.`);
    }

    if (idPairsCount > 500) {
        const limitedIdPairs = limitToLastEntries(idPairs, 500);
        fs.writeFileSync(PATHS.idPairs, JSON.stringify(limitedIdPairs, null, 2));
        console.log(`idPairs очищен до последних 500 объектов.`);
    }
}

// Универсальная функция для загрузки JSON из файла
function loadJsonFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');

            if (data) {
                try {
                    return JSON.parse(data);
                } catch (error) {
                    console.error(`Ошибка парсинга JSON из файла ${filePath}:`, error);
                    return {}; // Возвращаем пустой объект в случае ошибки
                }
            } else {
                console.log(`Файл ${filePath} пуст.`);
                return {}; // Возвращаем пустой объект, если файл пуст
            }
        } else {
            console.log(`Файл ${filePath} не найден. Создание пустого объекта.`);
            return {}; // Возвращаем пустой объект, если файл не существует
        }
    } catch (error) {
        console.error(`Ошибка при загрузке файла ${filePath}:`, error);
        return {}; // Возвращаем пустой объект в случае ошибки
    }
}

// Загрузка существующих сопоставлений из файла
function loadIdUrlMappings() {
  try {
    const raw = fs.readFileSync(PATHS.ID_URL_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Не удалось загрузить idurl.json, создаем пустой объект.', err);
    return {};
  }
}

// Сохранение сопоставлений в файл
function saveIdUrlMappings(mappings) {
  try {
    fs.writeFileSync(PATHS.ID_URL_PATH, JSON.stringify(mappings, null, 2));
    console.log('idurl.json обновлен');
  } catch (err) {
    console.error('Ошибка при сохранении idurl.json', err);
  }
}

// Загрузка кэша idcom (ID компании => content)
function loadIdCom() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.IDCOM_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveIdCom(obj) {
  fs.writeFileSync(PATHS.IDCOM_PATH, JSON.stringify(obj, null, 2));
}

// Получение ID компании из текста сообщения
function extractCompanyId(content) {
  // Поиск ID компании с учётом регистра и формата
  const match = content.match(/id\s*компании\s*:?\s*(\d+)/i);
  return match ? match[1] : null;
}

// Функция для ограничения количества объектов в JSON до последних n объектов
function limitToLastEntries(obj, limit) {
    const entries = Object.entries(obj);
    const limitedEntries = entries.slice(-limit);  // Оставляем только последние limit объектов
    return Object.fromEntries(limitedEntries);  // Преобразуем обратно в объект
}

// Новая cron-задача, которая будет выполняться ежедневно
cron.schedule('0 9 * * *', () => {
    console.log('Запущена ежедневная очистка кэша и старых задач...');

    // Очистка кэша, оставляя только последние 200 объектов
    clearCacheIfTooManyObjects();
}, {
    scheduled: true,
    timezone: "Europe/Moscow"
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});;
