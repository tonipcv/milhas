# Telegram Message Forwarder

Bot para encaminhamento automático de mensagens entre grupos do Telegram.

## Requisitos

- Node.js >= 18.0.0
- PostgreSQL
- Telegram API credentials

## Configuração

1. Clone o repositório
2. Instale as dependências:
```bash
npm install
```

3. Configure as variáveis de ambiente no arquivo `.env`:
```env
TELEGRAM_BOT_TOKEN=seu_bot_token
TELEGRAM_API_ID=seu_api_id
TELEGRAM_API_HASH=seu_api_hash
DATABASE_URL=sua_url_do_postgres
```

4. Execute as migrações do banco de dados:
```bash
npx prisma migrate deploy
```

5. Inicie o bot:
```bash
npm start
```

## Uso

1. Execute o bot e faça login com sua conta do Telegram
2. Selecione o grupo de origem das mensagens
3. Selecione o grupo de destino
4. O bot começará a encaminhar automaticamente as novas mensagens

## Variáveis de Ambiente

- `TELEGRAM_BOT_TOKEN`: Token do seu bot do Telegram
- `TELEGRAM_API_ID`: API ID do Telegram
- `TELEGRAM_API_HASH`: API Hash do Telegram
- `DATABASE_URL`: URL de conexão com o banco de dados PostgreSQL

## Licença

ISC 