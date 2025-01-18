require('dotenv').config();

const MTProto = require('@mtproto/core');
const crypto = require('crypto');
const readline = require('readline');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Configuração do MTProto
const mtproto = new MTProto({
    api_id: parseInt(process.env.TELEGRAM_API_ID),
    api_hash: process.env.TELEGRAM_API_HASH,
    storageOptions: {
        path: './data/session.json'
    },
    deviceModel: 'Chrome',
    systemVersion: 'macOS',
    appVersion: '1.0.0',
    useWSS: true,
    customInitConnection: {
        _: 'initConnection',
        api_id: parseInt(process.env.TELEGRAM_API_ID),
        device_model: 'Chrome',
        system_version: 'macOS',
        app_version: '1.0.0',
        system_lang_code: 'pt-BR',
        lang_pack: '',
        lang_code: 'pt-BR',
        proxy: undefined,
        params: {
            _: 'jsonObject',
            data: JSON.stringify({
                application: 'desktop',
                os: 'macOS',
                timezone: 'America/Sao_Paulo'
            })
        }
    }
});

// Interface para leitura de input do usuário
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Função para tentar novamente após migração de DC
async function retryWithDc(method, params, dcId) {
    mtproto.setDefaultDc(dcId);
    return await mtproto.call(method, params);
}

// Função para perguntar ao usuário
function askQuestion(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
}

// Função para obter o access_hash de um canal/grupo
async function getChannelAccessHash(channelId) {
    try {
        const result = await mtproto.call('channels.getChannels', {
            id: [{
                _: 'inputChannel',
                channel_id: Math.abs(channelId),
                access_hash: 0
            }]
        });
        
        if (result && result.chats && result.chats.length > 0) {
            return result.chats[0].access_hash;
        }
        throw new Error('Canal não encontrado');
    } catch (error) {
        console.error('Erro ao obter access_hash:', error);
        throw error;
    }
}

// Função para listar todos os grupos e permitir seleção
async function selectGroup(prompt) {
    try {
        // Obter todos os diálogos
        const dialogs = await mtproto.call('messages.getDialogs', {
            offset_date: 0,
            offset_id: 0,
            offset_peer: {
                _: 'inputPeerEmpty'
            },
            limit: 100,
            hash: 0
        });

        // Filtrar apenas grupos e canais
        const groups = dialogs.chats.filter(chat => 
            chat._ === 'channel' || 
            chat._ === 'chat'
        );

        if (groups.length === 0) {
            console.log('Nenhum grupo encontrado!');
            return null;
        }

        // Mostrar lista numerada de grupos
        console.log('\nGrupos disponíveis:');
        console.log('------------------');
        groups.forEach((group, index) => {
            let type;
            if (group._ === 'channel') {
                type = group.megagroup ? '(Supergrupo)' : '(Canal)';
            } else {
                type = '(Grupo)';
            }
            console.log(`${index + 1}. ${group.title} ${type}`);
        });
        console.log('------------------');

        // Solicitar seleção
        const selection = await askQuestion(`\n${prompt} (digite o número): `);
        const index = parseInt(selection) - 1;

        if (isNaN(index) || index < 0 || index >= groups.length) {
            console.log('Seleção inválida!');
            return await selectGroup(prompt);
        }

        const selectedGroup = groups[index];
        console.log(`Selecionado: ${selectedGroup.title}`);
        
        // Retornar informações do grupo com tipo correto
        // Tanto canais quanto supergrupos usam inputPeerChannel
        return {
            id: selectedGroup.id,
            access_hash: selectedGroup.access_hash || 0,
            title: selectedGroup.title,
            isChannel: selectedGroup._ === 'channel', // true para canais E supergrupos
            type: selectedGroup._ === 'channel' 
                ? (selectedGroup.megagroup ? 'supergroup' : 'channel') 
                : 'chat'
        };
    } catch (error) {
        console.error('Erro ao listar grupos:', error);
        throw error;
    }
}

// Função para lidar com erros de flood wait
async function handleFloodWait(error) {
    if (error.error_message.startsWith('FLOOD_WAIT_')) {
        const seconds = parseInt(error.error_message.split('_').pop());
        const minutes = Math.ceil(seconds / 60);
        console.log(`\nO Telegram está limitando as requisições. Precisamos esperar ${minutes} minutos.`);
        console.log('Isso acontece para proteger contra spam. Você pode:');
        console.log('1. Esperar o tempo indicado e tentar novamente');
        console.log('2. Tentar mais tarde');
        console.log('\nPressione Ctrl+C para sair.');
        
        // Aguardar o tempo necessário
        await new Promise(resolve => setTimeout(resolve, (seconds + 5) * 1000));
        return true;
    }
    return false;
}

// Função para tentar reconectar
async function tryReconnect(error) {
    console.log('Erro detectado, tentando reconectar...');
    console.error('Detalhes do erro:', error);
    
    // Espera 5 segundos antes de tentar novamente
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Se for erro de flood wait, trata especialmente
    if (error.error_code === 420) {
        await handleFloodWait(error);
    }
    
    return true; // Continua o loop
}

// Função para salvar mensagem no banco de dados
async function saveMessage(message, sourceGroup, targetGroup) {
    try {
        await prisma.message.create({
            data: {
                messageId: message.id,
                sourceGroupId: parseInt(sourceGroup.id),
                sourceGroupName: sourceGroup.title,
                targetGroupId: parseInt(targetGroup.id),
                targetGroupName: targetGroup.title,
                content: message.message || null,
                mediaType: message.media ? message.media._ : null,
                createdAt: new Date(message.date * 1000)
            }
        });
    } catch (error) {
        if (error.code !== 'P2002') { // Ignora erro de duplicação
            console.error('Erro ao salvar mensagem:', error);
        }
    }
}

// Função para carregar histórico inicial
async function loadInitialHistory(sourceGroup, targetGroup) {
    try {
        const sourcePeer = sourceGroup.isChannel ? {
            _: 'inputPeerChannel',
            channel_id: sourceGroup.id,
            access_hash: sourceGroup.access_hash
        } : {
            _: 'inputPeerChat',
            chat_id: sourceGroup.id
        };

        const messages = await mtproto.call('messages.getHistory', {
            peer: sourcePeer,
            offset_id: 0,
            offset_date: 0,
            add_offset: 0,
            limit: 100,
            max_id: 0,
            min_id: 0,
            hash: 0
        });

        if (messages && messages.messages) {
            console.log(`Carregando ${messages.messages.length} mensagens do histórico...`);
            for (const message of messages.messages.reverse()) {
                await saveMessage(message, sourceGroup, targetGroup);
            }
            console.log('Histórico carregado com sucesso!');
            return messages.messages[0]?.id || 0;
        }
        return 0;
    } catch (error) {
        console.error('Erro ao carregar histórico:', error);
        return 0;
    }
}

// Função principal
async function main() {
    while (true) {
        try {
            console.log('Iniciando processo de autenticação...');
            
            // Solicitar número de telefone
            const phoneNumber = await askQuestion('Digite seu número de telefone (ex: 5511999999999): ');
            
            // Enviar código
            console.log('Enviando código de verificação...');
            let sendCodeResult;
            try {
                sendCodeResult = await mtproto.call('auth.sendCode', {
                    phone_number: phoneNumber,
                    api_id: parseInt(process.env.TELEGRAM_API_ID),
                    api_hash: process.env.TELEGRAM_API_HASH,
                    settings: {
                        _: 'codeSettings',
                        allow_flashcall: false,
                        current_number: true,
                        allow_app_hash: true,
                        allow_missed_call: false,
                        allow_sms: true
                    }
                });
            } catch (error) {
                if (error.error_code === 303) {
                    const dcId = parseInt(error.error_message.split('_').pop());
                    console.log(`Migrando para DC${dcId}...`);
                    mtproto.setDefaultDc(dcId);
                    sendCodeResult = await mtproto.call('auth.sendCode', {
                        phone_number: phoneNumber,
                        api_id: parseInt(process.env.TELEGRAM_API_ID),
                        api_hash: process.env.TELEGRAM_API_HASH,
                        settings: {
                            _: 'codeSettings',
                            allow_flashcall: false,
                            current_number: true,
                            allow_app_hash: true,
                            allow_missed_call: false,
                            allow_sms: true
                        }
                    });
                } else {
                    await tryReconnect(error);
                    continue;
                }
            }
            
            console.log('Código enviado!');
            const code = await askQuestion('Digite o código recebido: ');
            
            try {
                const signInResult = await mtproto.call('auth.signIn', {
                    phone_number: phoneNumber,
                    phone_code: code,
                    phone_code_hash: sendCodeResult.phone_code_hash
                });
                
                console.log('Login realizado com sucesso!');
                
                while (true) { // Loop infinito para seleção de grupos
                    try {
                        console.log('\nVamos selecionar os grupos para encaminhamento.');
                        
                        // Selecionar grupo de origem
                        const sourceGroup = await selectGroup('Selecione o grupo de ORIGEM das mensagens');
                        if (!sourceGroup) {
                            console.log('Erro ao selecionar grupo de origem, tentando novamente...');
                            continue;
                        }

                        // Selecionar grupo de destino
                        const targetGroup = await selectGroup('Selecione o grupo de DESTINO das mensagens');
                        if (!targetGroup) {
                            console.log('Erro ao selecionar grupo de destino, tentando novamente...');
                            continue;
                        }

                        console.log('\nConfiguração concluída:');
                        console.log(`Origem: ${sourceGroup.title}`);
                        console.log(`Destino: ${targetGroup.title}`);
                        console.log('\nCarregando histórico inicial...');

                        // Carregar histórico inicial
                        let lastMessageId = await loadInitialHistory(sourceGroup, targetGroup);
                        console.log('\nMonitorando novas mensagens...');

                        while (true) {
                            try {
                                // Criar peer de origem com tipo correto
                                const sourcePeer = sourceGroup.isChannel ? {
                                    _: 'inputPeerChannel',
                                    channel_id: sourceGroup.id,
                                    access_hash: sourceGroup.access_hash
                                } : {
                                    _: 'inputPeerChat',
                                    chat_id: sourceGroup.id
                                };

                                const messages = await mtproto.call('messages.getHistory', {
                                    peer: sourcePeer,
                                    offset_id: 0,
                                    offset_date: 0,
                                    add_offset: 0,
                                    limit: 1,
                                    max_id: 0,
                                    min_id: 0,
                                    hash: 0
                                });
                                
                                if (messages && messages.messages && messages.messages.length > 0) {
                                    const message = messages.messages[0];
                                    
                                    // Se é uma mensagem nova
                                    if (message.id > lastMessageId) {
                                        lastMessageId = message.id;
                                        
                                        try {
                                            // Criar peer de destino com tipo correto
                                            const targetPeer = targetGroup.isChannel ? {
                                                _: 'inputPeerChannel',
                                                channel_id: targetGroup.id,
                                                access_hash: targetGroup.access_hash
                                            } : {
                                                _: 'inputPeerChat',
                                                chat_id: targetGroup.id
                                            };

                                            // Encaminhar a mensagem
                                            await mtproto.call('messages.forwardMessages', {
                                                from_peer: sourcePeer,
                                                to_peer: targetPeer,
                                                id: [message.id],
                                                random_id: [Math.floor(Math.random() * 1000000000)]
                                            });

                                            // Salvar mensagem no banco
                                            await saveMessage(message, sourceGroup, targetGroup);
                                            
                                            console.log(`Mensagem encaminhada de "${sourceGroup.title}" para "${targetGroup.title}"`);
                                        } catch (forwardError) {
                                            console.error('Erro ao encaminhar mensagem:', forwardError);
                                            await tryReconnect(forwardError);
                                        }
                                    }
                                }
                                
                                // Aguardar 1 segundo antes de verificar novamente
                                await new Promise(resolve => setTimeout(resolve, 1000));
                            } catch (monitorError) {
                                console.error('Erro ao monitorar mensagens:', monitorError);
                                await tryReconnect(monitorError);
                            }
                        }
                    } catch (groupError) {
                        console.error('Erro na seleção de grupos:', groupError);
                        await tryReconnect(groupError);
                    }
                }
            } catch (error) {
                if (error.error_message === 'SESSION_PASSWORD_NEEDED') {
                    console.log('Autenticação 2FA necessária');
                    const password = await askQuestion('Digite sua senha 2FA: ');
                    
                    try {
                        const passwordInfo = await mtproto.call('account.getPassword');
                        const { srp_id, current_algo, srp_B } = passwordInfo;
                        const { salt1, salt2, g, p } = current_algo;
                        
                        const hash = await computePasswordHash(password, current_algo);
                        
                        const checkPasswordResult = await mtproto.call('auth.checkPassword', {
                            password: {
                                _: 'inputCheckPasswordSRP',
                                srp_id,
                                A: hash.toString('hex'),
                                M1: hash.toString('hex')
                            }
                        });
                        
                        console.log('Login com 2FA realizado com sucesso!');
                    } catch (twoFAError) {
                        console.error('Erro na autenticação 2FA:', twoFAError);
                        await tryReconnect(twoFAError);
                        continue;
                    }
                } else {
                    await tryReconnect(error);
                    continue;
                }
            }
        } catch (error) {
            await tryReconnect(error);
            continue;
        }
    }
}

// Funções auxiliares para SRP
function sha256(data) {
    return crypto.createHash('sha256').update(data).digest();
}

function pbkdf2(password, salt, iterations) {
    return crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512');
}

async function computePasswordHash(password, algo) {
    const { salt1, salt2, g, p, iterations } = algo;
    const hash1 = pbkdf2(password, salt1, iterations);
    const hash2 = pbkdf2(hash1, salt2, iterations);
    const hash3 = pbkdf2(hash2, salt1, 1);
    return hash3;
}

// Iniciar o programa
main().catch(console.error);

// Tratamento de interrupção
process.once('SIGINT', () => {
    console.log('\nEncerrando...');
    rl.close();
    process.exit(0);
});

