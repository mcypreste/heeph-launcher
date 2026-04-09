Coloque o arquivo "authlib-injector.jar" nesta pasta antes de buildar o instalador.

Download: https://github.com/yushijinhun/authlib-injector/releases/latest

O electron-builder vai incluir este arquivo automaticamente no instalador via extraResources.
No launcher instalado, ele fica em: <pasta_do_app>/resources/authlib-injector.jar
Em desenvolvimento (npm start), ele é lido de: heeph-launcher/resources/authlib-injector.jar
