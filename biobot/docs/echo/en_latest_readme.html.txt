Docs
»
Welcome to
echo_api
âs documentation!
Edit on GitHub
Welcome to
echo_api
âs documentation!
Â¶
This project is a work in progress, and contributions are encouraged. If
you have questions feels free to contact me at
jjorissen52
@
gmail
.
com
Installation
Â¶
pip install echo_api
Configuration
Â¶
Secrets
Â¶
echo_api
is configured to take credentials from a file named
echo.conf
that is expected by default in your working directory.
echo.conf
should look like:
[
echo
]
username
=
UserName
password
=
Password
wsdl_location
=
/
path
/
to
/
wsdl
.
xml
endpoint
=
https
:
//
cloud
.
echooneappcloud
.
com
/
yourorganizationname
/
OneAppWebService
If you want
echo.conf
to be somewhere other than your project
directory, you will need to set it the location using an environment
variable.
# Linux
export
INTERFACE_CONF_FILE
=/
absolute
/
path
/
to
/
conf_file
.
conf
#name doesn't matter
# Or set in Python before you import echo_api
import
os
os
.
environ
[
"INTERFACE_CONF_FILE"
]
=
'/absolute/path/to/conf_file.conf'
Note that you must have credentials for a user that has access to the
API before you can proceed.
SOAP API WSDL Definition
Â¶
Due to the possibility of some configuration issues on Echoâs side, you
will need to manually inspect the XML describing the API and ensure that
the endpoint definition is correct. Copy and paste this into the address
bar on your browser (you will need to change it to be your
organization):
https://cloud.echooneappcloud.com/yourorganization/OneAppWebService.svc?singleWsdl
Copy and paste the XML response into an XML file (
wsdl.xml
) in your
project directory and scroll all the way to the bottom until you see:
<
wsdl
:
port
name
=
"BasicHttpBinding_OneAppWebService_SSL"
binding
=
"tns:BasicHttpBinding_OneAppWebService_SSL"
>
<
soap
:
address
location
=
"https://eoaapp0.echooneapp.com/YourOrganization/OneAppWebService.svc"
/>
</
wsdl
:
port
>
</
wsdl
:
service
>
You will want to change
<
soap
:
address
location
=
"https://eoaapp0.echooneapp.com/YourOrganization/OneAppWebService.svc"
/>
to
<
soap
:
address
location
=
"https://cloud.echooneappcloud.com/yourorganization/OneAppWebService"
/>
Once youâve set up your wsdl and secrets files, test your connection.
For a secrets file that will remain in your project directory, simply
use:
from
echo_api
import
api
# Connection() will log you in if everything is correctly configured.
connection
=
api
.
BaseConnection
()
connection
.
session_id
'61d63ecc7571430a9ead84dfc7f6301d'
If you see a string like the one above, it means that a connection was
successfully established and youâve got the hard part doneâ¦
connection
.
API_Logout
()
'LoggedOut|kathleen.reynolds'
Usage
Â¶
The
BaseConnection
object has all of the API definitions provided by
the WSDL file. The API documentation can be found at
read the docs.